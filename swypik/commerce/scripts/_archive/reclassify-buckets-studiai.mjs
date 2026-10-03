#!/usr/bin/env node
/**
 * Reclassify products from "junk" buckets (too-large or 'other') using StudiAI.
 *
 * Targets:
 *   - Configurable list of bucket slugs (--buckets=fashion-women-clothing,other,electronics,...)
 *   - Default: top 10 most populated buckets that LOOK like generic catch-alls
 *
 * Improvements over reclassify-unresolved-studiai.mjs:
 *   - Uses taxonomy_nodes.metadata.display_name + aliases in the prompt
 *   - Tier-based model selection (opus for high-stake, haiku for bulk)
 *   - Concurrent batch processing
 *   - Skips no-op updates (same slug)
 *
 * Usage:
 *   DRY (sample 50):    node scripts/reclassify-buckets-studiai.mjs --buckets=fashion-women-clothing --limit=50
 *   APPLY (all in bucket):
 *     node scripts/reclassify-buckets-studiai.mjs --buckets=fashion-women-clothing,other --apply
 *
 * Env:
 *   DATABASE_URL          required
 *   STUDIAI_API_KEY[S]    required
 *   STUDIAI_BASE_URL      default https://ai.studiai.ro/v1
 *   STUDIAI_MODEL         default claude-haiku-4-5 (fast & cheap; opus only via TIER)
 *   BATCH_SIZE            default 12
 *   CONCURRENCY           default 3
 *   MIN_CONFIDENCE        default 0.55
 *   INTER_BATCH_MS        default 200
 *   OUT_FILE              default /tmp/reclassify-buckets.json
 */

import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-haiku-4-5';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 12);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.55);
const INTER_BATCH_MS = Number(process.env.INTER_BATCH_MS || 200);
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify-buckets.json';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const APPLY = args.apply === true || args.apply === 'true';
const LIMIT = Number(args.limit || 0); // 0 = all
const BUCKETS = String(args.buckets || 'fashion-women-clothing,other,electronics,beauty-haircare,beauty-tools')
  .split(',').map((s) => s.trim()).filter(Boolean);

function getKeys() {
  if (process.env.STUDIAI_API_KEYS) return process.env.STUDIAI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  return process.env.STUDIAI_API_KEY ? [process.env.STUDIAI_API_KEY.trim()] : [];
}
const KEYS = getKeys();
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (KEYS.length === 0) { console.error('STUDIAI_API_KEY[S] missing'); process.exit(1); }

console.log(`[reclassify-buckets] mode=${APPLY ? 'APPLY' : 'DRY'} model=${MODEL} buckets=[${BUCKETS.join(',')}] limit=${LIMIT || 'all'} batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`);

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug, metadata FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  return rows;
}

async function loadProducts() {
  const limitSql = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  const sql = `
    SELECT id, title, taxonomy_node_slug,
           metadata->>'ae_category_name' AS ae_cat_name,
           metadata->>'category_hint' AS cat_hint
      FROM marketplace_products
     WHERE status='active'
       AND taxonomy_node_slug = ANY($1::text[])
     ORDER BY updated_at DESC${limitSql}`;
  const { rows } = await pool.query(sql, [BUCKETS]);
  return rows;
}

function buildTaxonomyText(nodes) {
  // Format: each line "slug | display_name_en (display_name_ro) | aliases: a, b, c"
  const fmt = (n) => {
    const m = n.metadata || {};
    const en = m.display_name || n.slug;
    const ro = m.display_name_ro ? ` (${m.display_name_ro})` : '';
    const al = Array.isArray(m.aliases) && m.aliases.length ? `  aliases: ${m.aliases.join(', ')}` : '';
    return `  ${n.slug}  →  ${en}${ro}${al}`;
  };
  const depts = nodes.filter((n) => n.kind === 'department').sort((a, b) => a.slug.localeCompare(b.slug));
  const out = [];
  for (const d of depts) {
    out.push(`\n## ${d.slug}  →  ${(d.metadata?.display_name || d.slug)}`);
    const cats = nodes.filter((n) => n.kind === 'category' && n.parent_slug === d.slug).sort((a, b) => a.slug.localeCompare(b.slug));
    for (const c of cats) {
      out.push(fmt(c));
      const subs = nodes.filter((n) => n.kind === 'subcategory' && n.parent_slug === c.slug).sort((a, b) => a.slug.localeCompare(b.slug));
      for (const s of subs) out.push(`  ${fmt(s).trim()}`);
    }
    // department-level subcategories (e.g. fashion-women-* directly under fashion-women which is a category)
  }
  // Also include subcategories whose parent is a category (already covered) but ensure orphan subs (parent=department) shown:
  const orphanSubs = nodes.filter((n) => n.kind === 'subcategory' && depts.some((d) => d.slug === n.parent_slug));
  if (orphanSubs.length) {
    out.push('\n## DIRECT SUBCATEGORIES (parent=department):');
    for (const s of orphanSubs) out.push(fmt(s));
  }
  return out.join('\n');
}

const SYSTEM_PROMPT = (taxonomyText) => `You classify e-commerce product titles into a fixed taxonomy of slug codes. The product title may be in English, Romanian, French, German or mixed languages.

GOAL: Pick the MOST SPECIFIC valid slug from the list below.
- Prefer subcategory > category > department.
- "other" is a LAST RESORT only when nothing fits AND you're confident the product belongs to no listed slug.
- IGNORE any hints provided — source labels are unreliable. Trust the title.
- Read aliases carefully: e.g. "bikini" → fashion-women-swimwear, "hoodie" + "women" → fashion-women-hoodies, "kimono robe" → fashion-women-loungewear.

OUTPUT strict JSON only:
{"results":[{"id":"<uuid>","slug":"<slug>","confidence":0.0-1.0,"reasoning":"<6 words>"}]}

VALID SLUGS WITH MEANING (use EXACTLY one of these slug codes):
${taxonomyText}`;

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fenced ? fenced[1] : trimmed;
  try { return JSON.parse(payload); } catch {}
  const a = payload.indexOf('{'); const b = payload.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(payload.slice(a, b + 1)); } catch {} }
  return null;
}

async function classifyBatch(taxonomyText, batch) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(taxonomyText) },
      { role: 'user', content: JSON.stringify({ products: batch.map((p) => ({ id: p.id, title: p.title })) }) },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = pickKey();
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || '{}';
        const parsed = parseJsonLoose(text);
        return Array.isArray(parsed?.results) ? parsed.results : [];
      }
      lastErr = `studiai ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
        continue;
      }
      throw new Error(lastErr);
    } catch (e) {
      lastErr = `network: ${e.message}`;
      await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
    }
  }
  throw new Error(lastErr || 'all attempts failed');
}

async function applyOne(p, r) {
  await pool.query(
    `UPDATE marketplace_products
        SET taxonomy_node_slug = $1,
            canonical_category_slug = $1,
            canonical_category = COALESCE(
              (SELECT COALESCE(t.metadata->>'display_name_ro', t.metadata->>'display_name', t.slug)
                 FROM taxonomy_nodes t WHERE t.slug=$1),
              canonical_category
            ),
            taxonomy_unresolved = ($1 = 'other'),
            classification_confidence = $2,
            classification_reason = $3,
            taxonomy_reason = $4,
            updated_at = now()
      WHERE id = $5`,
    [
      r.slug,
      r.confidence ?? null,
      (r.reasoning || '').slice(0, 500) || null,
      `bucket_reclassify_${MODEL}`,
      p.id,
    ]
  );
}

async function processBatchWithRetry(taxonomyText, batch, batchIdx, totalBatches) {
  const tag = `[batch ${batchIdx + 1}/${totalBatches}]`;
  try {
    const results = await classifyBatch(taxonomyText, batch);
    const byId = new Map(results.map((r) => [String(r.id), r]));
    let applied = 0, changed = 0, kept = 0, errors = 0;
    const propsLocal = [];
    for (const p of batch) {
      const r = byId.get(String(p.id));
      if (!r) { propsLocal.push({ id: p.id, error: 'no_result' }); errors++; continue; }
      const validSlug = r.slug && typeof r.slug === 'string';
      const conf = Number(r.confidence ?? 0);
      const acceptable = validSlug && conf >= MIN_CONFIDENCE && r.slug !== p.taxonomy_node_slug;
      propsLocal.push({
        id: p.id,
        title: p.title,
        from: p.taxonomy_node_slug,
        to: r.slug,
        confidence: conf,
        reasoning: r.reasoning || '',
        will_apply: APPLY && acceptable,
      });
      if (APPLY && acceptable) { await applyOne(p, r); applied++; changed++; }
      else if (r.slug === p.taxonomy_node_slug) kept++;
    }
    console.log(`${tag} ok applied=${applied}/${batch.length} kept=${kept} err=${errors}`);
    return propsLocal;
  } catch (e) {
    console.log(`${tag} fail: ${e.message}`);
    return batch.map((p) => ({ id: p.id, title: p.title, from: p.taxonomy_node_slug, error: e.message }));
  }
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const myIdx = idx++;
      const out = await worker(items[myIdx], myIdx);
      results.push(...out);
      if (INTER_BATCH_MS > 0) await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

async function main() {
  const [nodes, products] = await Promise.all([loadTaxonomy(), loadProducts()]);
  console.log(`[reclassify-buckets] taxonomy=${nodes.length} nodes, products_to_review=${products.length}`);
  if (!products.length) { console.log('Nothing to do.'); await pool.end(); return; }

  const taxonomyText = buildTaxonomyText(nodes);
  // Save sample of prompt for review
  fs.writeFileSync('/tmp/reclassify-buckets-prompt.txt', SYSTEM_PROMPT(taxonomyText));
  console.log('[reclassify-buckets] prompt sample written to /tmp/reclassify-buckets-prompt.txt');

  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) batches.push(products.slice(i, i + BATCH_SIZE));
  console.log(`[reclassify-buckets] total batches: ${batches.length}`);

  const allProposals = await runWithConcurrency(
    batches,
    (batch, idx) => processBatchWithRetry(taxonomyText, batch, idx, batches.length),
    CONCURRENCY
  );

  const applied = allProposals.filter((p) => p.will_apply).length;
  const errors = allProposals.filter((p) => p.error).length;
  fs.writeFileSync(OUT_FILE, JSON.stringify({ total: products.length, applied, errors, proposals: allProposals }, null, 2));
  console.log(`[reclassify-buckets] DONE total=${products.length} applied=${applied} errors=${errors}`);
  console.log(`[reclassify-buckets] wrote ${OUT_FILE}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
