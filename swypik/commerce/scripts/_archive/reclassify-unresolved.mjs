#!/usr/bin/env node
/**
 * Reclassify products flagged taxonomy_unresolved=true using LLM.
 * Usage:
 *   DRY: node scripts/reclassify-unresolved.mjs
 *   APPLY: node scripts/reclassify-unresolved.mjs --apply
 *
 * Env: DATABASE_URL, GITHUB_MODELS_TOKENS (csv), GITHUB_MODELS_ENDPOINT, CLASSIFY_MODEL.
 */

import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const TOKENS = (process.env.GITHUB_MODELS_TOKENS || process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN || '')
  .split(',').map((t) => t.trim()).filter(Boolean);
let tokIdx = 0;
const nextToken = () => { const t = TOKENS[tokIdx % TOKENS.length]; tokIdx++; return t; };
const GH_ENDPOINT = process.env.GITHUB_MODELS_ENDPOINT || 'https://models.github.ai/inference';
const MODEL = process.env.CLASSIFY_MODEL || 'gpt-4o-mini';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);
const APPLY = process.argv.includes('--apply');
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify-unresolved.json';
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.55);

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (!TOKENS.length) { console.error('GITHUB_MODELS_TOKENS missing'); process.exit(1); }
console.log(`[reclassify] mode=${APPLY ? 'APPLY' : 'DRY'} tokens=${TOKENS.length} model=${MODEL}`);

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  return rows;
}

async function loadProducts() {
  const { rows } = await pool.query(
    `SELECT id, title, taxonomy_node_slug, taxonomy_department, taxonomy_category, taxonomy_subcategory, taxonomy_leaf
       FROM marketplace_products
      WHERE status = 'active' AND taxonomy_unresolved = true
      ORDER BY updated_at DESC`
  );
  return rows;
}

function buildTaxonomyText(nodes) {
  const depts = nodes.filter((n) => n.kind === 'department').map((n) => n.slug).sort();
  const lines = [];
  for (const d of depts) {
    lines.push(`# ${d}`);
    const cats = nodes.filter((n) => n.kind === 'category' && n.parent_slug === d).map((n) => n.slug).sort();
    for (const c of cats) {
      lines.push(`  - ${c}`);
      const subs = nodes.filter((n) => n.kind === 'subcategory' && n.parent_slug === c).map((n) => n.slug).sort();
      for (const s of subs) lines.push(`    * ${s}`);
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = (taxonomy) => `You classify e-commerce product titles into a fixed taxonomy with three levels: department > category > subcategory.

Pick the MOST SPECIFIC valid slug. Prefer a subcategory; fall back to category, then department. If NOTHING fits, use "other".

OUTPUT strict JSON only: {"results":[{"id":"<uuid>","slug":"<slug>","confidence":0.0-1.0,"unresolved":bool,"reasoning":"<short>"}]}

Set unresolved=true only when slug="other" or you are genuinely uncertain across departments.

TAXONOMY:
${taxonomy}`;

async function classifyBatch(taxonomyText, batch) {
  const userMsg = JSON.stringify({
    products: batch.map((p) => ({
      id: p.id,
      title: p.title,
      hints: {
        dep: p.taxonomy_department,
        cat: p.taxonomy_category,
        sub: p.taxonomy_subcategory,
        leaf: p.taxonomy_leaf,
      },
    })),
  });
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(taxonomyText) },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 1200,
  };
  let res, data, lastErr;
  const maxAttempts = TOKENS.length * 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tok = nextToken();
    res = await fetch(`${GH_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) { data = await res.json(); break; }
    lastErr = `LLM ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 403 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 + attempt * 1500));
      continue;
    }
    throw new Error(lastErr);
  }
  if (!data) throw new Error(lastErr || 'all attempts failed');
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content)?.results || [];
}

async function applyOne(p, r) {
  await pool.query(
    `UPDATE marketplace_products
        SET taxonomy_node_slug = $1,
            taxonomy_unresolved = $2,
            classification_confidence = $3,
            classification_reason = $4,
            taxonomy_reason = $5,
            updated_at = now()
      WHERE id = $6`,
    [
      r.slug,
      r.unresolved === true,
      r.confidence ?? null,
      r.reasoning?.slice(0, 500) || null,
      `llm_reclassify_${MODEL}`,
      p.id,
    ]
  );
}

async function main() {
  const [nodes, products] = await Promise.all([loadTaxonomy(), loadProducts()]);
  console.log(`[reclassify] taxonomy=${nodes.length} nodes, unresolved_products=${products.length}`);
  if (!products.length) { console.log('Nothing to do.'); await pool.end(); return; }

  const taxonomyText = buildTaxonomyText(nodes);
  const validSlugs = new Set(nodes.map((n) => n.slug));
  validSlugs.add('other');

  const proposals = [];
  let applied = 0;
  let skippedLowConf = 0;

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    process.stdout.write(`[batch ${i / BATCH_SIZE + 1}/${Math.ceil(products.length / BATCH_SIZE)}] `);
    try {
      const results = await classifyBatch(taxonomyText, batch);
      const byId = new Map(results.map((r) => [r.id, r]));
      for (const p of batch) {
        const r = byId.get(p.id);
        if (!r) { proposals.push({ id: p.id, error: 'no_result' }); continue; }
        const slugValid = validSlugs.has(r.slug);
        const acceptable = slugValid && (r.confidence ?? 0) >= MIN_CONFIDENCE && r.slug !== 'other';
        proposals.push({
          id: p.id,
          title: p.title,
          proposed_slug: r.slug,
          confidence: r.confidence ?? null,
          unresolved: r.unresolved ?? !slugValid,
          reasoning: r.reasoning || '',
          will_apply: APPLY && acceptable,
        });
        if (APPLY && acceptable) {
          await applyOne(p, r);
          applied++;
        } else if (APPLY) {
          skippedLowConf++;
        }
      }
      console.log('ok');
    } catch (e) {
      console.log(`fail: ${e.message}`);
      for (const p of batch) proposals.push({ id: p.id, title: p.title, error: e.message });
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ total: products.length, applied, skippedLowConf, proposals }, null, 2));
  console.log(`[reclassify] proposals=${proposals.length} applied=${applied} skippedLowConf=${skippedLowConf}`);
  console.log(`[reclassify] wrote ${OUT_FILE}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
