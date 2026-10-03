#!/usr/bin/env node
/**
 * Agent D — A/B test translator prompt v1 vs v2.
 * Picks N random RO-translated products, re-translates with v2, judges both with Claude judge.
 *
 * Usage:
 *   STUDIAI_API_KEYS=... node scripts/eval/ab-translate-v1-vs-v2.mjs --n=20
 *
 * Reads v1 from DB (existing product_translations row), generates v2 fresh.
 */

import fs from 'node:fs';
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-opus-4-7';
const KEYS = (process.env.STUDIAI_API_KEYS || process.env.STUDIAI_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const N = Number(args.n || 20);
const PROMPT_FILE = args.prompt || '/tmp/translator_v2_prompt.txt';
const CONCURRENCY = Number(args.concurrency || 4);

let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!DATABASE_URL || !KEYS.length) { console.error('DATABASE_URL or STUDIAI_API_KEY[S] missing'); process.exit(1); }
if (!fs.existsSync(PROMPT_FILE)) { console.error('prompt file missing:', PROMPT_FILE); process.exit(1); }

const V2_SYSTEM = fs.readFileSync(PROMPT_FILE, 'utf8');

const JUDGE_SYSTEM = `You are a senior Romanian e-commerce copy editor.
Evaluate ONE translated product listing (English source → Romanian).

Score each dimension 0-100 (integer):
- tone: natural commercial Romanian
- seo_keywords: brand/model/material/size/color/gender preserved
- specs_accuracy: numbers, codes preserved EXACTLY
- no_hallucinations: no invented features
- length_fit: seo_title 50-60, seo_description 140-160. Penalize <40 or >70 title, <120 or >170 desc

Return strict JSON: {"tone":0,"seo_keywords":0,"specs_accuracy":0,"no_hallucinations":0,"length_fit":0,"overall":0,"verdict":"good|ok|bad"}
overall = tone*0.2 + seo_keywords*0.25 + specs_accuracy*0.3 + no_hallucinations*0.2 + length_fit*0.05`;

async function callLLM(system, user, maxTokens = 800) {
  const key = pickKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: maxTokens }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(timer); }
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function pMap(items, fn, c) {
  const out = new Array(items.length); let i = 0;
  async function w() { while (true) { const idx = i++; if (idx >= items.length) break; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e?.message || e) }; } } }
  await Promise.all(Array.from({ length: c }, w));
  return out;
}

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { rows } = await pool.query(`
    SELECT p.id, p.title AS src_title, COALESCE(p.description, '') AS src_desc,
           t.title AS v1_title, t.description AS v1_desc, t.seo_title AS v1_seo_title, t.seo_description AS v1_seo_desc
    FROM marketplace_products p
    JOIN product_translations t ON t.product_id = p.id AND t.locale = 'ro'
    WHERE p.status = 'active' AND p.title IS NOT NULL AND length(p.title) > 30
    ORDER BY random()
    LIMIT $1
  `, [N]);
  await pool.end();

  console.log(`[ab] picked ${rows.length} products, generating v2 + judging both`);

  // Generate v2
  const t0 = Date.now();
  const v2Results = await pMap(rows, async (r) => {
    const userPayload = JSON.stringify({ results_needed: 1, items: [{ id: r.id, source_title: r.src_title, source_description: (r.src_desc || '').slice(0, 1500) }] });
    const text = await callLLM(V2_SYSTEM, userPayload, 800);
    const parsed = parseJson(text);
    return parsed?.results?.[0] || { error: 'parse_fail', raw: text.slice(0, 200) };
  }, CONCURRENCY);

  // Judge both
  const judgments = await pMap(rows, async (r, i) => {
    const v2 = v2Results[i] || {};
    const judgeV1 = await callLLM(JUDGE_SYSTEM, JSON.stringify({ source_en_title: r.src_title, ro_title: r.v1_title, ro_seo_title: r.v1_seo_title, ro_seo_description: r.v1_seo_desc, seo_title_len: (r.v1_seo_title || '').length, seo_description_len: (r.v1_seo_desc || '').length }), 400);
    const judgeV2 = await callLLM(JUDGE_SYSTEM, JSON.stringify({ source_en_title: r.src_title, ro_title: v2.title, ro_seo_title: v2.seo_title, ro_seo_description: v2.seo_description, seo_title_len: (v2.seo_title || '').length, seo_description_len: (v2.seo_description || '').length }), 400);
    return { product_id: r.id, src: r.src_title, v1: { title: r.v1_title, seo_title: r.v1_seo_title, seo_desc: r.v1_seo_desc, judge: parseJson(judgeV1) }, v2: { title: v2.title, seo_title: v2.seo_title, seo_desc: v2.seo_description, judge: parseJson(judgeV2) } };
  }, CONCURRENCY);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync('/tmp/ab_v1_v2_results.json', JSON.stringify(judgments, null, 2));

  const avg = (arr, k) => arr.reduce((a, x) => a + (Number(x) || 0), 0) / Math.max(1, arr.length);
  const v1Scores = judgments.map((j) => j.v1?.judge?.overall).filter((x) => x != null);
  const v2Scores = judgments.map((j) => j.v2?.judge?.overall).filter((x) => x != null);
  const dims = ['tone', 'seo_keywords', 'specs_accuracy', 'no_hallucinations', 'length_fit'];

  console.log('\n========== A/B v1 vs v2 ==========');
  console.log(`Sample: ${rows.length} | duration: ${dt}s`);
  console.log(`Overall  | v1=${avg(v1Scores, '').toFixed(1)}  vs  v2=${avg(v2Scores, '').toFixed(1)}`);
  for (const d of dims) {
    const a = avg(judgments.map((j) => j.v1?.judge?.[d]).filter((x) => x != null));
    const b = avg(judgments.map((j) => j.v2?.judge?.[d]).filter((x) => x != null));
    const delta = (b - a).toFixed(1);
    console.log(`${d.padEnd(20)} v1=${a.toFixed(1).padStart(5)}  v2=${b.toFixed(1).padStart(5)}  Δ=${delta}`);
  }

  // Length distribution
  const v1Lens = judgments.map((j) => (j.v1?.seo_title || '').length).filter((x) => x > 0);
  const v2Lens = judgments.map((j) => (j.v2?.seo_title || '').length).filter((x) => x > 0);
  console.log(`\nseo_title length avg: v1=${avg(v1Lens).toFixed(1)}  v2=${avg(v2Lens).toFixed(1)}`);
  const v1OkLen = v1Lens.filter((l) => l >= 50 && l <= 60).length;
  const v2OkLen = v2Lens.filter((l) => l >= 50 && l <= 60).length;
  console.log(`seo_title in 50-60 range: v1=${v1OkLen}/${v1Lens.length}  v2=${v2OkLen}/${v2Lens.length}`);

  const v1Descs = judgments.map((j) => (j.v1?.seo_desc || '').length).filter((x) => x > 0);
  const v2Descs = judgments.map((j) => (j.v2?.seo_desc || '').length).filter((x) => x > 0);
  console.log(`seo_desc length avg:  v1=${avg(v1Descs).toFixed(1)}  v2=${avg(v2Descs).toFixed(1)}`);
  const v1OkDesc = v1Descs.filter((l) => l >= 140 && l <= 160).length;
  const v2OkDesc = v2Descs.filter((l) => l >= 140 && l <= 160).length;
  console.log(`seo_desc in 140-160 range: v1=${v1OkDesc}/${v1Descs.length}  v2=${v2OkDesc}/${v2Descs.length}`);

  console.log(`\nFull A/B results: /tmp/ab_v1_v2_results.json`);
})();
