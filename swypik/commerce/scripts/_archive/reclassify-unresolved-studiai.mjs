#!/usr/bin/env node
/**
 * Reclassify products flagged taxonomy_unresolved=true using StudiAI (OpenAI-compatible).
 * Usage:
 *   DRY:   node scripts/reclassify-unresolved-studiai.mjs
 *   APPLY: node scripts/reclassify-unresolved-studiai.mjs --apply
 *
 * Env:
 *   DATABASE_URL          (required)
 *   STUDIAI_API_KEY       (required)  or STUDIAI_API_KEYS=key1,key2,... for round-robin
 *   STUDIAI_BASE_URL      (optional)  default https://ai.studiai.ro/v1
 *   STUDIAI_MODEL         (optional)  default claude-opus-4-7
 *   BATCH_SIZE            (optional)  default 10
 *   MIN_CONFIDENCE        (optional)  default 0.55
 *   INTER_BATCH_MS        (optional)  default 500
 *   OUT_FILE              (optional)  default /tmp/reclassify-unresolved.json
 */

import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-opus-4-7';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.55);
const INTER_BATCH_MS = Number(process.env.INTER_BATCH_MS || 500);
const APPLY = process.argv.includes('--apply');
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify-unresolved.json';

function getKeys() {
  if (process.env.STUDIAI_API_KEYS) {
    return process.env.STUDIAI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  }
  return process.env.STUDIAI_API_KEY ? [process.env.STUDIAI_API_KEY.trim()] : [];
}
const KEYS = getKeys();
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (KEYS.length === 0) { console.error('STUDIAI_API_KEY (or STUDIAI_API_KEYS) missing'); process.exit(1); }
console.log(`[reclassify] mode=${APPLY ? 'APPLY' : 'DRY'} model=${MODEL} batch=${BATCH_SIZE} keys=${KEYS.length}`);

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  return rows;
}

async function loadProducts() {
  const statusFilter = process.env.STATUS_FILTER || 'active';
  let where;
  if (statusFilter === 'all') {
    where = `(taxonomy_unresolved = true OR taxonomy_node_slug = 'other')`;
  } else {
    where = `status = '${statusFilter.replace(/'/g, "''")}' AND (taxonomy_unresolved = true OR taxonomy_node_slug = 'other')`;
  }
  const maxProducts = Number(process.env.MAX_PRODUCTS || 0);
  const limitSql = maxProducts > 0 ? ` LIMIT ${maxProducts}` : '';
  const { rows } = await pool.query(
    `SELECT id, title, taxonomy_node_slug, taxonomy_department, taxonomy_category, taxonomy_subcategory, taxonomy_leaf
       FROM marketplace_products
      WHERE ${where}
      ORDER BY updated_at DESC${limitSql}`
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

const SYSTEM_PROMPT = (taxonomy) => `You classify Romanian e-commerce product titles into a fixed taxonomy with three levels: department > category > subcategory.

Pick the MOST SPECIFIC valid slug. Prefer a subcategory; fall back to category, then department. If NOTHING fits, use "other".

Ignore the "hints" field — it may contain wrong labels from the source. Trust the title only.

OUTPUT strict JSON, no prose, no markdown fences:
{"results":[{"id":"<uuid>","slug":"<slug>","confidence":0.0-1.0,"unresolved":bool,"reasoning":"<short>"}]}

Set unresolved=true only when slug="other" or genuinely uncertain across departments.

TAXONOMY:
${taxonomy}`;

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fenced ? fenced[1] : trimmed;
  try { return JSON.parse(payload); } catch {}
  const firstBrace = payload.indexOf('{');
  const lastBrace = payload.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(payload.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  return null;
}

async function classifyBatch(taxonomyText, batch) {
  const userMsg = JSON.stringify({
    products: batch.map((p) => ({
      id: p.id,
      title: p.title,
    })),
  });
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(taxonomyText) },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = pickKey();
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = `network: ${e.message}`;
      await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '{}';
      const parsed = parseJsonLoose(text);
      return Array.isArray(parsed?.results) ? parsed.results : [];
    }
    lastErr = `studiai ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 + attempt * 3000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr || 'all attempts failed');
}

async function applyOne(p, r) {
  // Auto-promote draft -> active when reclass succeeds and quality gates pass.
  const promoteSql = process.env.PROMOTE_DRAFT === '0' ? '' : `,
            status = CASE
              WHEN status = 'draft'
                AND $2 = false
                AND $1 <> 'other'
                AND COALESCE(price_cents, 0) > 0
                AND NULLIF(BTRIM(image_url), '') IS NOT NULL
                AND effective_label = 'safe'
                AND COALESCE(is_adult, false) = false
              THEN 'active'
              ELSE status
            END`;
  await pool.query(
    `UPDATE marketplace_products
        SET taxonomy_node_slug = $1,
            taxonomy_unresolved = $2,
            classification_confidence = $3,
            classification_reason = $4,
            taxonomy_reason = $5,
            updated_at = now()${promoteSql}
      WHERE id = $6`,
    [
      r.slug,
      r.unresolved === true,
      r.confidence ?? null,
      (r.reasoning || '').slice(0, 500) || null,
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
  let skipped = 0;
  const totalBatches = Math.ceil(products.length / BATCH_SIZE);

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const tag = `[batch ${i / BATCH_SIZE + 1}/${totalBatches}]`;
    try {
      const results = await classifyBatch(taxonomyText, batch);
      const byId = new Map(results.map((r) => [String(r.id), r]));
      let batchApplied = 0;
      for (const p of batch) {
        const r = byId.get(String(p.id));
        if (!r) { proposals.push({ id: p.id, error: 'no_result' }); skipped++; continue; }
        const slugValid = validSlugs.has(r.slug);
        const acceptable = slugValid && (r.confidence ?? 0) >= MIN_CONFIDENCE && r.slug !== 'other' && r.unresolved !== true;
        proposals.push({
          id: p.id,
          title: p.title,
          proposed_slug: r.slug,
          confidence: r.confidence ?? null,
          unresolved: r.unresolved ?? !slugValid,
          reasoning: r.reasoning || '',
          will_apply: APPLY && acceptable,
        });
        if (APPLY && acceptable) { await applyOne(p, r); applied++; batchApplied++; }
        else if (APPLY) skipped++;
      }
      console.log(`${tag} ok applied=${batchApplied}/${batch.length}`);
    } catch (e) {
      console.log(`${tag} fail: ${e.message}`);
      for (const p of batch) { proposals.push({ id: p.id, title: p.title, error: e.message }); skipped++; }
    }
    if (INTER_BATCH_MS > 0 && i + BATCH_SIZE < products.length) {
      await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ total: products.length, applied, skipped, proposals }, null, 2));
  console.log(`[reclassify] total=${products.length} applied=${applied} skipped=${skipped}`);
  console.log(`[reclassify] wrote ${OUT_FILE}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
