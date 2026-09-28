#!/usr/bin/env node
/**
 * Agent D — Eval post-tier: compară calitatea traducerilor opus vs haiku.
 *
 * Selectează automat 50 produse cu model_tag opus-v2.2 (high-traffic) +
 * 50 cu model_tag haiku-v2.2 (low-traffic), aceeași locale, prompt version
 * identică (v2.2). Judge = Claude opus-4-7 cu rubric identic din eval-translations.mjs.
 *
 * Pass criteria pentru haiku (conform task):
 *   - overall >= 85
 *   - length_fit >= 85
 *   - no_hallucinations >= 85
 *
 * Usage:
 *   STUDIAI_API_KEY=sk_... DATABASE_URL=... \
 *     node scripts/eval/eval-tier-quality.mjs [--locale=ro] [--n=50] [--prompt=v2.2]
 *
 * Output:
 *   /tmp/eval_tier_quality_<locale>_<ts>.json — per-row scores + verdict
 *   stdout — summary cu PASS/FAIL per criteriu
 */

import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

// ============ Config ============
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const LOCALE = (args.locale || 'ro').toLowerCase();
const N_PER_TIER = Number(args.n || 50);
const PROMPT_VER = args.prompt || 'v2.2';
const CONCURRENCY = Number(args.concurrency || 4);

const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-opus-4-7';
const KEYS = (process.env.STUDIAI_API_KEYS || process.env.STUDIAI_API_KEY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!KEYS.length) { console.error('STUDIAI_API_KEY[S] missing'); process.exit(1); }
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = args.out || `/tmp/eval_tier_quality_${LOCALE}_${TS}.json`;

// Pass thresholds (per task)
const PASS = {
  overall: Number(args.pass_overall || 85),
  length_fit: Number(args.pass_length || 85),
  no_hallucinations: Number(args.pass_hallucin || 85),
};

// ============ DB sample selection ============
const pool = new Pool({ connectionString: DATABASE_URL });

async function sampleForModel(modelTag) {
  // Selectează N produse RANDOM cu traducere matching + source EN.
  // JOIN cu marketplace_products pentru sursa EN și pentru context.
  const sql = `
    WITH ro AS (
      SELECT pt.product_id, pt.title AS ro_title,
             pt.seo_title, pt.seo_description,
             LENGTH(pt.seo_title) AS st_len,
             LENGTH(pt.seo_description) AS sd_len,
             pt.model_tag, pt.updated_at
      FROM product_translations pt
      WHERE pt.locale = $1 AND pt.model_tag = $2
        AND pt.seo_title IS NOT NULL AND pt.seo_description IS NOT NULL
        AND LENGTH(pt.title) > 5
    ),
    src AS (
      SELECT mp.id AS product_id, mp.title AS src_en_title,
             mp.description AS src_en_description
      FROM marketplace_products mp
      WHERE mp.status = 'active'
    )
    SELECT ro.product_id, src.src_en_title,
           ro.ro_title, ro.seo_title, ro.seo_description,
           ro.st_len, ro.sd_len, ro.model_tag
    FROM ro JOIN src ON src.product_id = ro.product_id
    ORDER BY random()
    LIMIT $3
  `;
  const r = await pool.query(sql, [LOCALE, modelTag, N_PER_TIER]);
  return r.rows;
}

// ============ Judge prompt (mirror eval-translations.mjs) ============
const JUDGE_SYSTEM = `You are a senior ${LOCALE === 'ro' ? 'Romanian' : LOCALE === 'es' ? 'Spanish (Castilian)' : 'English'} e-commerce copy editor.
Evaluate ONE translated product listing (English source → target language).

Score each dimension 0-100 (integer):
- tone: natural commercial language, NOT literal/clunky. Penalize awkward word order, robotic phrasing.
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
      target_title: row.ro_title,
      target_seo_title: row.seo_title,
      target_seo_description: row.seo_description,
      seo_title_len: Number(row.st_len),
      seo_description_len: Number(row.sd_len),
    });
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
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

// ============ Aggregate ============
function aggregate(scored) {
  const ok = scored.filter((s) => s.ok);
  const fail = scored.filter((s) => !s.ok);
  const avg = (k) => ok.reduce((a, s) => a + (Number(s.data?.[k]) || 0), 0) / Math.max(1, ok.length);
  const median = (k) => {
    const vals = ok.map((s) => Number(s.data?.[k]) || 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    const m = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  };
  const verdictCount = ok.reduce((m, s) => {
    const v = s.data.verdict || 'unknown';
    m[v] = (m[v] || 0) + 1; return m;
  }, {});
  const allIssues = ok.flatMap((s) => s.data.issues || []);
  const issueFreq = allIssues.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
  return {
    n: scored.length, ok: ok.length, fail: fail.length,
    tone: { avg: avg('tone'), median: median('tone') },
    seo_keywords: { avg: avg('seo_keywords'), median: median('seo_keywords') },
    specs_accuracy: { avg: avg('specs_accuracy'), median: median('specs_accuracy') },
    no_hallucinations: { avg: avg('no_hallucinations'), median: median('no_hallucinations') },
    length_fit: { avg: avg('length_fit'), median: median('length_fit') },
    overall: { avg: avg('overall'), median: median('overall') },
    verdicts: verdictCount,
    top_issues: Object.entries(issueFreq).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

// ============ Main ============
(async () => {
  console.log(`[eval-tier] locale=${LOCALE} N=${N_PER_TIER} prompt=${PROMPT_VER} judge=${JUDGE_MODEL}`);

  const OPUS_TAG = `claude-opus-4-7-prompt-${PROMPT_VER}`;
  const HAIKU_TAG = `claude-haiku-4-5-prompt-${PROMPT_VER}`;

  console.log(`[sample] opus tag="${OPUS_TAG}", haiku tag="${HAIKU_TAG}"`);
  const [opusRows, haikuRows] = await Promise.all([
    sampleForModel(OPUS_TAG),
    sampleForModel(HAIKU_TAG),
  ]);
  console.log(`[sample] opus=${opusRows.length} haiku=${haikuRows.length}`);

  if (opusRows.length < N_PER_TIER / 2 || haikuRows.length < N_PER_TIER / 2) {
    console.error(`[FATAL] insufficient sample size; need ${N_PER_TIER} per tier`);
    await pool.end();
    process.exit(2);
  }

  const t0 = Date.now();
  console.log(`[judge] starting (concurrency=${CONCURRENCY})...`);

  const [opusResults, haikuResults] = await Promise.all([
    pMap(opusRows, judgeOne, CONCURRENCY),
    pMap(haikuRows, judgeOne, CONCURRENCY),
  ]);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[judge] complete in ${dt}s`);

  const opusAgg = aggregate(opusResults);
  const haikuAgg = aggregate(haikuResults);

  // Per-row records for save
  const persisted = {
    meta: {
      locale: LOCALE, prompt: PROMPT_VER, judge: JUDGE_MODEL,
      n_per_tier: N_PER_TIER, duration_sec: dt,
      pass_thresholds: PASS,
      timestamp: new Date().toISOString(),
    },
    opus: { agg: opusAgg, rows: opusResults.map((r, i) => ({ ...opusRows[i], ...r })) },
    haiku: { agg: haikuAgg, rows: haikuResults.map((r, i) => ({ ...haikuRows[i], ...r })) },
  };
  fs.writeFileSync(OUT, JSON.stringify(persisted, null, 2));

  // ============ Output ============
  const fmt = (n) => Number(n).toFixed(1);
  const cell = (a, b) => `${fmt(a).padStart(6)}  vs ${fmt(b).padStart(6)}  Δ ${(b - a >= 0 ? '+' : '')}${fmt(b - a).padStart(5)}`;
  console.log('\n========== TIER QUALITY COMPARISON ==========');
  console.log(`Locale: ${LOCALE} | Prompt: ${PROMPT_VER} | Judge: ${JUDGE_MODEL}`);
  console.log(`Sample: opus=${opusAgg.n} (ok=${opusAgg.ok}, fail=${opusAgg.fail}) | haiku=${haikuAgg.n} (ok=${haikuAgg.ok}, fail=${haikuAgg.fail})`);
  console.log(`\nMetric              opus     haiku    delta (haiku-opus)`);
  console.log(`tone:               ${cell(opusAgg.tone.avg, haikuAgg.tone.avg)}`);
  console.log(`seo_keywords:       ${cell(opusAgg.seo_keywords.avg, haikuAgg.seo_keywords.avg)}`);
  console.log(`specs_accuracy:     ${cell(opusAgg.specs_accuracy.avg, haikuAgg.specs_accuracy.avg)}`);
  console.log(`no_hallucinations:  ${cell(opusAgg.no_hallucinations.avg, haikuAgg.no_hallucinations.avg)}`);
  console.log(`length_fit:         ${cell(opusAgg.length_fit.avg, haikuAgg.length_fit.avg)}`);
  console.log(`OVERALL:            ${cell(opusAgg.overall.avg, haikuAgg.overall.avg)}`);
  console.log(`\nVerdicts opus :`, opusAgg.verdicts);
  console.log(`Verdicts haiku:`, haikuAgg.verdicts);
  console.log(`Top issues haiku:`, haikuAgg.top_issues.slice(0, 5));

  // PASS/FAIL haiku
  console.log(`\n========== HAIKU PASS/FAIL (threshold = ${PASS.overall}/${PASS.length_fit}/${PASS.no_hallucinations}) ==========`);
  const checks = [
    { k: 'overall', val: haikuAgg.overall.avg, thr: PASS.overall },
    { k: 'length_fit', val: haikuAgg.length_fit.avg, thr: PASS.length_fit },
    { k: 'no_hallucinations', val: haikuAgg.no_hallucinations.avg, thr: PASS.no_hallucinations },
  ];
  let allPass = true;
  for (const c of checks) {
    const pass = c.val >= c.thr;
    if (!pass) allPass = false;
    console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  haiku.${c.k} = ${fmt(c.val)} (threshold ${c.thr})`);
  }

  console.log(`\n========== RECOMMENDATION ==========`);
  if (allPass) {
    const ratio = (haikuAgg.overall.avg / opusAgg.overall.avg * 100).toFixed(1);
    console.log(`✅ HAIKU TIER VALIDATED. Quality at ${ratio}% of opus. Cost savings justified.`);
    console.log(`   Recommend: keep TIER_OPUS_RATIO=0.5 (current) or even reduce to 0.3 for further savings.`);
  } else {
    console.log(`❌ HAIKU TIER FAILS at least one criterion.`);
    const fails = checks.filter((c) => c.val < c.thr);
    for (const f of fails) {
      console.log(`   - ${f.k}: ${fmt(f.val)} < ${f.thr}`);
      if (f.k === 'length_fit') console.log(`     Fix: tighten prompt instructions on char counts (50-60 title, 140-160 desc) + maxTokens raise`);
      if (f.k === 'no_hallucinations') console.log(`     Fix: add "DO NOT invent features/specs" guard în prompt + lower temperature`);
      if (f.k === 'overall') console.log(`     Fix: revert TIER_OPUS_RATIO la 0.7-0.8 (mai mult opus) sau switch haiku → sonnet`);
    }
  }

  console.log(`\nFull JSON: ${OUT}`);
  await pool.end();
  process.exit(allPass ? 0 : 1);
})();
