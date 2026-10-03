#!/usr/bin/env node
/**
 * Pass 3: re-classify products still in 'other' (or any specified bucket) WITH
 * server-side slug validation BEFORE update. Recovers the ~1300 products that
 * failed Pass 1/2 due to LLM-hallucinated slug names.
 *
 * Key differences from reclassify-buckets-studiai.mjs:
 *   - Loads valid slugs into a Set at startup
 *   - Validates proposed slug against the Set; if invalid, walks UP the slug
 *     chain (slug-with-dashes -> parent prefix) to find a valid ancestor
 *   - If still invalid, logs as 'hallucinated' (no DB write, no FK error)
 *   - Per-row UPDATE (no batched UPDATE), so one bad row doesn't kill 11 others
 *
 * Usage:
 *   APPLY:   node reclassify-pass3-validated.mjs --buckets=other --apply
 */

import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-haiku-4-5';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 12);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.55);
const INTER_BATCH_MS = Number(process.env.INTER_BATCH_MS || 100);
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify_pass3.json';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const APPLY = args.apply === true || args.apply === 'true';
const LIMIT = Number(args.limit || 0);
const BUCKETS = String(args.buckets || 'other')
  .split(',').map((s) => s.trim()).filter(Boolean);
const REASON_PATTERN = args['reason-pattern'] ? String(args['reason-pattern']) : null;

function getKeys() {
  if (process.env.STUDIAI_API_KEYS) return process.env.STUDIAI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  return process.env.STUDIAI_API_KEY ? [process.env.STUDIAI_API_KEY.trim()] : [];
}
const KEYS = getKeys();
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (KEYS.length === 0) { console.error('STUDIAI_API_KEY[S] missing'); process.exit(1); }

console.log(`[pass3] mode=${APPLY ? 'APPLY' : 'DRY'} model=${MODEL} buckets=[${BUCKETS.join(',')}] limit=${LIMIT || 'all'} batch=${BATCH_SIZE} conc=${CONCURRENCY}`);

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

let VALID_SLUGS = new Set();
let SLUG_TO_PARENT = new Map();

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug, metadata FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  for (const r of rows) {
    VALID_SLUGS.add(r.slug);
    if (r.parent_slug) SLUG_TO_PARENT.set(r.slug, r.parent_slug);
  }
  console.log(`[pass3] loaded ${VALID_SLUGS.size} valid slugs`);
  return rows;
}

function buildTaxonomyText(rows) {
  const lines = [];
  for (const r of rows) {
    const meta = r.metadata || {};
    const aliasArr = Array.isArray(meta.aliases) ? meta.aliases : [];
    const name = meta.display_name || meta.display_name_ro || r.slug;
    const aliases = aliasArr.length > 0 ? ` (also: ${aliasArr.join(', ')})` : '';
    const parent = r.parent_slug ? ` [parent=${r.parent_slug}]` : '';
    lines.push(`- ${r.slug}: ${name}${aliases}${parent}`);
  }
  return lines.join('\n');
}

async function loadProducts() {
  const limitSql = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';
  const reasonSql = REASON_PATTERN ? ` AND taxonomy_reason LIKE $2` : '';
  const params = REASON_PATTERN ? [BUCKETS, REASON_PATTERN] : [BUCKETS];
  const sql = `
    SELECT id, title, taxonomy_node_slug,
           COALESCE(brand, '') AS brand,
           COALESCE(metadata->>'ae_category_name','') AS ae_cat
      FROM marketplace_products
     WHERE status = 'active'
       AND taxonomy_node_slug = ANY($1::text[])${reasonSql}
     ORDER BY updated_at DESC NULLS LAST${limitSql}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Try to recover a hallucinated slug by walking ancestors (strip trailing -segment).
function recoverSlug(badSlug) {
  if (!badSlug || typeof badSlug !== 'string') return null;
  if (VALID_SLUGS.has(badSlug)) return badSlug;
  // walk: fashion-women-tops-shirts -> fashion-women-tops -> fashion-women -> fashion
  let cur = badSlug;
  for (let i = 0; i < 5; i++) {
    const idx = cur.lastIndexOf('-');
    if (idx <= 0) break;
    cur = cur.slice(0, idx);
    if (VALID_SLUGS.has(cur)) return cur;
  }
  return null;
}

async function classifyBatch(taxonomyText, batch) {
  const items = batch.map((p) => ({
    id: p.id,
    title: p.title.slice(0, 200),
    brand: p.brand?.slice(0, 60) || '',
    ae_cat: p.ae_cat?.slice(0, 120) || '',
  }));
  const system = `You are a multilingual e-commerce taxonomy classifier. Pick the BEST matching slug from the TAXONOMY for each product. Use the slug EXACTLY as listed. If no good fit, use "other".

TAXONOMY:
${taxonomyText}`;
  const user = `Classify each product. Return ONLY JSON:
[{"id":"<id>","slug":"<exact slug from taxonomy>","confidence":0.0-1.0,"reasoning":"<≤200 chars why>"}]

PRODUCTS:
${JSON.stringify(items)}`;

  const attempts = 4;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const apiKey = pickKey();
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.1,
          max_tokens: 3000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastErr = `${res.status} ${txt.slice(0, 100)}`;
          await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
          continue;
        }
        throw new Error(`${res.status} ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const m = content.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('no_json_array');
      return JSON.parse(m[0]);
    } catch (e) {
      lastErr = e.message;
      await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
    }
  }
  throw new Error(lastErr || 'all attempts failed');
}

async function applyOne(productId, finalSlug, conf, reasoning) {
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
    [finalSlug, conf, (reasoning || '').slice(0, 500) || null, `pass3_validated_${MODEL}`, productId]
  );
}

async function processBatch(taxonomyText, batch, batchIdx, totalBatches) {
  const tag = `[batch ${batchIdx + 1}/${totalBatches}]`;
  try {
    const results = await classifyBatch(taxonomyText, batch);
    const byId = new Map(results.map((r) => [String(r.id), r]));
    let applied = 0, kept = 0, recovered = 0, hallucinated = 0, errors = 0;
    const propsLocal = [];
    for (const p of batch) {
      const r = byId.get(String(p.id));
      if (!r) { errors++; continue; }
      const conf = Number(r.confidence ?? 0);
      const proposed = r.slug;
      let finalSlug = recoverSlug(proposed);
      const wasRecovered = finalSlug !== null && finalSlug !== proposed;
      if (finalSlug === null) {
        hallucinated++;
        propsLocal.push({ id: p.id, from: p.taxonomy_node_slug, proposed_bad: proposed, status: 'hallucinated' });
        continue;
      }
      if (finalSlug === p.taxonomy_node_slug) { kept++; continue; }
      if (conf < MIN_CONFIDENCE) { kept++; continue; }
      if (APPLY) {
        try {
          await applyOne(p.id, finalSlug, conf, r.reasoning);
          applied++;
          if (wasRecovered) recovered++;
          propsLocal.push({ id: p.id, from: p.taxonomy_node_slug, to: finalSlug, conf, recovered: wasRecovered });
        } catch (e) {
          errors++;
          propsLocal.push({ id: p.id, from: p.taxonomy_node_slug, to: finalSlug, error: e.message });
        }
      } else {
        propsLocal.push({ id: p.id, from: p.taxonomy_node_slug, to: finalSlug, conf, will_apply: true, recovered: wasRecovered });
      }
    }
    console.log(`${tag} ok applied=${applied} recovered=${recovered} kept=${kept} hallucinated=${hallucinated} err=${errors}`);
    return propsLocal;
  } catch (e) {
    console.log(`${tag} FAIL: ${e.message}`);
    return batch.map((p) => ({ id: p.id, error: e.message }));
  }
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const myIdx = idx++;
      const r = await worker(items[myIdx], myIdx, items.length);
      results.push(r);
      if (INTER_BATCH_MS > 0) await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results.flat();
}

(async () => {
  const tax = await loadTaxonomy();
  const taxText = buildTaxonomyText(tax);
  const products = await loadProducts();
  console.log(`[pass3] products_to_review=${products.length}`);
  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) batches.push(products.slice(i, i + BATCH_SIZE));
  console.log(`[pass3] total batches: ${batches.length}`);

  const allProps = await runWithConcurrency(
    batches,
    (batch, bi) => processBatch(taxText, batch, bi, batches.length),
    CONCURRENCY,
  );

  const summary = {
    total: allProps.length,
    applied: allProps.filter((p) => p.to && !p.error).length,
    recovered: allProps.filter((p) => p.recovered).length,
    hallucinated: allProps.filter((p) => p.status === 'hallucinated').length,
    errors: allProps.filter((p) => p.error).length,
  };
  console.log(`[pass3] DONE`, summary);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ summary, proposals: allProps }, null, 2));
  console.log(`[pass3] wrote ${OUT_FILE}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
