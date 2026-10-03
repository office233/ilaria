#!/usr/bin/env node
/**
 * Reclassify products flagged taxonomy_unresolved=true using GitHub Copilot API.
 * Replaces older Gemini + GH Models direct variants.
 *
 * Usage:
 *   DRY:   node scripts/reclassify-unresolved-copilot.mjs
 *   APPLY: node scripts/reclassify-unresolved-copilot.mjs --apply
 *
 * Env:
 *   DATABASE_URL, GITHUB_MODELS_TOKENS (csv ghu_*),
 *   CLASSIFY_MODEL (default: openai/gpt-5-mini),
 *   BATCH_SIZE (default 8), INTER_BATCH_MS (default 1500),
 *   MIN_CONFIDENCE (default 0.75), LIMIT (optional, cap rows for testing).
 */

import pg from 'pg';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const TOKENS = (process.env.GITHUB_MODELS_TOKENS || process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN || '')
  .split(',').map((t) => t.trim()).filter(Boolean);
const MODEL = process.env.CLASSIFY_MODEL || 'gpt-5-mini';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);
const INTER_BATCH_MS = Number(process.env.INTER_BATCH_MS || 1500);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.75);
const LIMIT = Number(process.env.LIMIT || 0);
const APPLY = process.argv.includes('--apply');
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify-copilot.json';

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (!TOKENS.length) { console.error('GITHUB_MODELS_TOKENS missing'); process.exit(1); }
console.log(`[reclassify] mode=${APPLY ? 'APPLY' : 'DRY'} model=${MODEL} batch=${BATCH_SIZE} tokens=${TOKENS.length} min_conf=${MIN_CONFIDENCE}${LIMIT ? ' limit=' + LIMIT : ''}`);

const pool = new Pool({ connectionString: DATABASE_URL });

/* ---------- Copilot API (ghu_ → session token → /chat/completions) ---------- */
const CACHE_FILE = pjoin(tmpdir(), 'swypik-copilot-sessions.json');
const EDITOR_HEADERS = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.20.0',
  'User-Agent': 'GitHubCopilotChat/0.20.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const _memCache = new Map();
let _diskLoaded = false;
async function loadDiskCache() {
  if (_diskLoaded) return; _diskLoaded = true;
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) _memCache.set(k, v);
  } catch { /* ok */ }
}
async function saveDiskCache() {
  const obj = {};
  for (const [k, v] of _memCache.entries()) obj[k] = v;
  try { await fsp.writeFile(CACHE_FILE, JSON.stringify(obj), 'utf8'); } catch { /* ok */ }
}
async function fetchSessionToken(ghu) {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { ...EDITOR_HEADERS, Authorization: `token ${ghu}` },
  });
  if (!res.ok) throw new Error(`session ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.token || !j.endpoints?.api || !j.expires_at) throw new Error('session missing fields');
  return { token: j.token, endpoint: j.endpoints.api, expiresAt: j.expires_at };
}
async function getSession(ghu) {
  await loadDiskCache();
  const now = Math.floor(Date.now() / 1000);
  const cached = _memCache.get(ghu);
  if (cached && cached.expiresAt - 60 > now) return cached;
  const fresh = await fetchSessionToken(ghu);
  _memCache.set(ghu, fresh);
  void saveDiskCache();
  return fresh;
}
function normalizeGpt5Body(body) {
  const m = String(body?.model || '');
  if (!m.startsWith('gpt-5') && !m.startsWith('openai/gpt-5')) return body;
  const out = { ...body };
  if (typeof out.max_tokens === 'number' && out.max_completion_tokens === undefined) {
    out.max_completion_tokens = out.max_tokens;
  }
  delete out.max_tokens;
  delete out.temperature;
  if (out?.response_format?.type === 'json_object' && Array.isArray(out.messages)) {
    const hasJson = out.messages.some((m) => typeof m?.content === 'string' && /json/i.test(m.content));
    if (!hasJson) out.messages = [{ role: 'system', content: 'Reply ONLY with valid JSON.' }, ...out.messages];
  }
  return out;
}
async function copilotChat(body) {
  let lastErr = '';
  for (let i = 0; i < TOKENS.length; i++) {
    const ghu = TOKENS[i];
    let session;
    try { session = await getSession(ghu); }
    catch (e) { console.warn(`[copilot] session exchange #${i + 1} fail: ${e.message}`); continue; }
    const url = session.endpoint.replace(/\/+$/, '') + '/chat/completions';
    const normalized = normalizeGpt5Body(body);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...EDITOR_HEADERS, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 300);
    lastErr = `tok#${i + 1} HTTP ${res.status}: ${text}`;
    if ([401, 403, 429].includes(res.status)) {
      _memCache.delete(ghu);
      console.warn(`[copilot] ${lastErr} — rotating`);
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(`all tokens failed: ${lastErr}`);
}

/* ---------- taxonomy + products ---------- */
async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  return rows;
}
async function loadProducts() {
  const limClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
  const { rows } = await pool.query(
    `SELECT id, title FROM marketplace_products
      WHERE status = 'active' AND taxonomy_unresolved = true
      ORDER BY updated_at DESC ${limClause}`
  );
  return rows;
}
function buildTaxonomyText(nodes) {
  const byKind = (k) => nodes.filter((n) => n.kind === k);
  const depts = byKind('department');
  const lines = [];
  for (const d of depts) {
    lines.push(`* ${d.slug}`);
    const cats = byKind('category').filter((c) => c.parent_slug === d.slug);
    for (const c of cats) {
      lines.push(`  - ${c.slug}`);
      const subs = byKind('subcategory').filter((s) => s.parent_slug === c.slug);
      for (const s of subs) lines.push(`    * ${s.slug}`);
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You classify e-commerce products into a strict taxonomy. Use ONLY slugs from the provided tree.

CRITICAL RULES — apply in order:
1. The slug MUST describe what the product PRIMARILY IS — not what it is "for" (cables/screen protectors for iPhone are NOT phone-cases).
2. "jeans" / "denim" in title → fashion-*-jeans. NEVER classify jeans as shirts/tshirts.
3. "shirt" / "blouse" / "tricou" → fashion-*-shirts or fashion-*-tshirts.
4. Baby/toddler products require explicit baby keywords (baby, infant, toddler, newborn, diaper, stroller, crib, pacifier, bebe). Women's bikini/kimono/jumpsuit/dress is NEVER baby.
5. Phone cases require words: case, cover, carcas, husa, sleeve, pouch, skin, bumper. Otherwise NOT cases.
6. SIM products require "sim" in title.
7. Sports-outdoor requires: tactical, outdoor, camping, hiking, tent, backpack, fishing, hunting, sport, cargo. NOT pijamale/halate/sleepwear.
8. Bathroom requires: bath, shower, toilet, towel, sink, faucet, baie, dush. Women's clothing is NEVER bathroom.
9. Beauty: makeup (lipstick, mascara, etc.), haircare (shampoo, conditioner, hair dye, beard), fragrance (perfume, parfum, eau de).
10. If you cannot be confident (≥0.75) about the correct slug → set unresolved=true and slug="other".

Output: STRICT JSON object {"results":[{"id":"...","slug":"...","confidence":0.0-1.0,"unresolved":bool,"reasoning":"≤120 chars"}]} — one entry per input id. No prose. Reply ONLY with valid JSON.`;

async function classifyBatch(taxonomyText, batch) {
  const userText = `Taxonomy tree:\n${taxonomyText}\n\nProducts:\n${batch.map((p) => `- id=${p.id} | title="${(p.title || '').slice(0, 220)}"`).join('\n')}`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 4096,
    temperature: 0,
  };
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const j = await copilotChat(body);
      const text = j?.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      return parsed?.results || [];
    } catch (e) {
      lastErr = e.message;
      const m = /HTTP (\d+)/.exec(lastErr);
      const code = m ? Number(m[1]) : 0;
      if (code === 429 || code === 503 || code === 500) {
        await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * Math.pow(2, attempt))));
        continue;
      }
      throw e;
    }
  }
  throw new Error(lastErr || 'all attempts failed');
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
    [r.slug, r.unresolved === true, r.confidence ?? null, (r.reasoning || '').slice(0, 500) || null, `llm_reclassify_copilot_${MODEL}`, p.id]
  );
}

const SLUG_KEYWORDS = {
  'jeans': ['jeans','denim'],
  'tshirts': ['t-shirt','t shirt','tshirt','tee','tricou','jersey'],
  'shirts': ['shirt','blouse','cama','chemise'],
  'shorts': ['short','bermuda'],
  'pants': ['pant','trouser','jogger','legging'],
  'dresses': ['dress','gown','rochie','robe','mariée','bridal','wedding'],
  'cases': ['case','cover','carcas','husa','sleeve','pouch','skin','bumper'],
  'sim': ['sim'],
  'baby': ['baby','infant','toddler','newborn','diaper','stroller','crib','pacifier','bebe'],
  'shoes': ['shoe','sneaker','boot','sandal','heel','pantofi','încălț','incalt','loafer'],
  'bathroom': ['bath','shower','toilet','towel','sink','faucet','baie','dush'],
  'outdoor': ['tactical','outdoor','camping','hiking','tent','backpack','fishing','hunting'],
  'makeup': ['makeup','lipstick','foundation','mascara','eyeliner','rimel','ruj'],
  'haircare': ['hair','shampoo','conditioner','beard','perii păr'],
  'fragrance': ['perfume','fragrance','cologne','parfum','eau de'],
};

async function main() {
  const [nodes, products] = await Promise.all([loadTaxonomy(), loadProducts()]);
  console.log(`[reclassify] taxonomy=${nodes.length} nodes, unresolved_products=${products.length}`);
  if (!products.length) { console.log('Nothing to do.'); await pool.end(); return; }

  const taxonomyText = buildTaxonomyText(nodes);
  const validSlugs = new Set(nodes.map((n) => n.slug));
  validSlugs.add('other');

  const proposals = [];
  let applied = 0, skipped = 0;
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
        const titleLower = String(p.title || '').toLowerCase();
        const slugTokens = String(r.slug || '').split('-').filter((t) => t.length > 3);
        let keywordOk = true;
        for (const tok of slugTokens) {
          const kws = SLUG_KEYWORDS[tok];
          if (!kws) continue;
          keywordOk = kws.some((kw) => titleLower.includes(kw));
          if (!keywordOk) break;
        }
        const acceptable = slugValid && (r.confidence ?? 0) >= MIN_CONFIDENCE && r.slug !== 'other' && r.unresolved !== true && keywordOk;
        proposals.push({
          id: p.id, title: p.title, proposed_slug: r.slug,
          confidence: r.confidence ?? null, unresolved: r.unresolved ?? !slugValid,
          reasoning: r.reasoning || '', will_apply: APPLY && acceptable,
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
