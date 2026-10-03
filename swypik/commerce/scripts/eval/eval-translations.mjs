#!/usr/bin/env node
/**
 * Agent D — Evaluate quality of existing RO translations using Claude judge.
 *
 * Reads CSV from /tmp/agent_d_ro_sample.csv (or --input=path).
 * Scores each row 0-100 on 5 dimensions: tone, seo_keywords, specs, hallucinations, length.
 * Writes per-row scores to /tmp/agent_d_eval_results.json + summary to stdout.
 *
 * Usage:
 *   STUDIAI_API_KEY=sk_... node scripts/eval/eval-translations.mjs --input=/tmp/agent_d_ro_sample.csv
 */

import fs from 'node:fs';

const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-opus-4-7';
const KEYS = (process.env.STUDIAI_API_KEYS || process.env.STUDIAI_API_KEY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!KEYS.length) { console.error('STUDIAI_API_KEY[S] missing'); process.exit(1); }

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const INPUT = args.input || '/tmp/agent_d_ro_sample.csv';
const OUT = args.out || '/tmp/agent_d_eval_results.json';
const CONCURRENCY = Number(args.concurrency || 4);

function parseCsv(text) {
  // Simple CSV parser supporting quoted fields with commas.
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
        row = []; cur = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else { cur += c; }
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const JUDGE_SYSTEM = `You are a senior Romanian e-commerce copy editor.
Evaluate ONE translated product listing (English source → Romanian).

Score each dimension 0-100 (integer):
- tone: natural commercial Romanian, NOT literal/clunky. Penalize awkward word order, robotic phrasing.
- seo_keywords: key product attributes preserved (brand, model, material, size, color, gender).
- specs_accuracy: numbers, dimensions, model codes preserved EXACTLY. Penalize any drift.
- no_hallucinations: NO invented features, prices, claims. Penalize fabricated content.
- length_fit: seo_title 50-60 chars target, seo_description 140-160 chars target. Penalize <40 or >70 title, <120 or >170 desc.

Also flag MAJOR issues in "issues" array (e.g. "brand_dropped", "wrong_model_number", "hallucinated_feature").

Return STRICT JSON only, no fences:
{"tone":0,"seo_keywords":0,"specs_accuracy":0,"no_hallucinations":0,"length_fit":0,"overall":0,"issues":["..."],"verdict":"good|ok|bad"}

overall = weighted: tone*0.2 + seo_keywords*0.25 + specs_accuracy*0.3 + no_hallucinations*0.2 + length_fit*0.05`;

async function judgeOne(row) {
  const key = pickKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const userMsg = JSON.stringify({
      source_en_title: row.src_en_title,
      ro_title: row.ro_title,
      ro_seo_title: row.seo_title,
      ro_seo_description: row.seo_description,
      seo_title_len: Number(row.st_len),
      seo_description_len: Number(row.sd_len),
    });
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}: ${(await res.text()).slice(0, 100)}`);
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no_json');
    return JSON.parse(m[0]);
  } finally { clearTimeout(timer); }
}

async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try { out[idx] = { ok: true, data: await fn(items[idx], idx) }; }
      catch (e) { out[idx] = { ok: false, error: String(e?.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

(async () => {
  const text = fs.readFileSync(INPUT, 'utf8');
  const rows = parseCsv(text);
  const header = rows.shift();
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const items = rows
    .filter((r) => r.length >= header.length && r[idx.ro_title])
    .map((r) => ({
      product_id: r[idx.product_id],
      src_en_title: r[idx.src_en_title],
      ro_title: r[idx.ro_title],
      seo_title: r[idx.seo_title],
      seo_description: r[idx.seo_description],
      st_len: r[idx.st_len],
      sd_len: r[idx.sd_len],
    }));

  console.log(`[eval] judging ${items.length} translations with ${MODEL} (${KEYS.length} keys, c=${CONCURRENCY})`);
  const t0 = Date.now();
  const results = await pMap(items, judgeOne, CONCURRENCY);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const scored = results.map((r, i) => ({ product_id: items[i].product_id, item: items[i], ...r }));
  fs.writeFileSync(OUT, JSON.stringify(scored, null, 2));

  // Aggregate
  const ok = scored.filter((s) => s.ok);
  const fail = scored.filter((s) => !s.ok);
  const avg = (k) => ok.reduce((a, s) => a + (Number(s.data?.[k]) || 0), 0) / Math.max(1, ok.length);
  const verdictCount = ok.reduce((m, s) => { m[s.data.verdict || 'unknown'] = (m[s.data.verdict || 'unknown'] || 0) + 1; return m; }, {});
  const allIssues = ok.flatMap((s) => s.data.issues || []);
  const issueFreq = allIssues.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});

  console.log('\n========== EVAL SUMMARY ==========');
  console.log(`Sample size: ${items.length} | ok: ${ok.length} | fail: ${fail.length} | duration: ${dt}s`);
  console.log(`Avg tone:           ${avg('tone').toFixed(1)} / 100`);
  console.log(`Avg seo_keywords:   ${avg('seo_keywords').toFixed(1)} / 100`);
  console.log(`Avg specs_accuracy: ${avg('specs_accuracy').toFixed(1)} / 100`);
  console.log(`Avg no_hallucin:    ${avg('no_hallucinations').toFixed(1)} / 100`);
  console.log(`Avg length_fit:     ${avg('length_fit').toFixed(1)} / 100`);
  console.log(`Avg OVERALL:        ${avg('overall').toFixed(1)} / 100`);
  console.log(`Verdicts:`, verdictCount);
  console.log(`Top issues:`, Object.entries(issueFreq).sort((a, b) => b[1] - a[1]).slice(0, 10));
  if (fail.length) {
    console.log(`\nFailures (${fail.length}):`);
    fail.slice(0, 5).forEach((s, i) => console.log(`  [${i}] ${s.error}`));
  }
  console.log(`\nFull results: ${OUT}`);
})();
