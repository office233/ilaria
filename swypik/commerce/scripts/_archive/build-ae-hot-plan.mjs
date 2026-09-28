#!/usr/bin/env node
/**
 * Build a fresh import_plan_hot.jsonl from AliExpress DS recommend feeds.
 *
 * Pipeline:
 *   1) aliexpress.ds.feedname.get → list of 100+ promo feeds with product counts
 *   2) For each selected feed: aliexpress.ds.recommend.feed.get → paginate IDs
 *   3) Dedupe against ae_import_jobs + marketplace_products
 *   4) Write JSONL the bulk worker can ingest with --plan=<file>
 *
 * Env:
 *   ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET / ALIEXPRESS_ACCESS_TOKEN
 *   DATABASE_URL                   (@postgres → @127.0.0.1 rewrite)
 *   OUT_FILE                       default /opt/swypik/data/import_plan_hot.jsonl
 *   PAGE_SIZE                      default 50 (max accepted: ~50)
 *   PAGES_PER_FEED                 default 20  (so up to 1000 IDs/feed)
 *   MAX_PER_FEED                   default 1000 (hard stop)
 *   MAX_TOTAL                      default 20000
 *   COUNTRY / LANGUAGE / CURRENCY  default RO / EN / USD
 *   FEEDS                          comma-separated explicit feed names (skip auto-pick)
 *   DRY                            default 0
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const APP_KEY    = process.env.ALIEXPRESS_APP_KEY    || '';
const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET || '';
const TOKEN      = process.env.ALIEXPRESS_ACCESS_TOKEN || '';
if (!APP_KEY || !APP_SECRET || !TOKEN) { console.error('AE credentials missing'); process.exit(1); }

const RAW = process.env.DATABASE_URL;
if (!RAW) { console.error('DATABASE_URL missing'); process.exit(1); }
const url = new URL(RAW);
if (url.hostname === 'postgres') url.hostname = '127.0.0.1';
const pool = new Pool({ connectionString: url.toString(), max: 3 });

const OUT_FILE = process.env.OUT_FILE || '/opt/swypik/data/import_plan_hot.jsonl';
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const PAGES_PER_FEED = Number(process.env.PAGES_PER_FEED || 20);
const MAX_PER_FEED = Number(process.env.MAX_PER_FEED || 1000);
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 20000);
const COUNTRY = process.env.COUNTRY || 'RO';
const LANGUAGE = process.env.LANGUAGE || 'EN';
const CURRENCY = process.env.CURRENCY || 'USD';
const EXPLICIT_FEEDS = (process.env.FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.env.DRY === '1';

// Preferred feeds: balanced category coverage that maps to our personas.
// Picked from `aliexpress.ds.feedname.get` (real, verified 2026-05-28).
// "hint" = our internal taxonomy slug prefix (used as category_hint for worker).
const PREFERRED_FEEDS = [
  { name: 'DS_NewArrivals',                       hint: null,                       weight: 2 },
  { name: 'DS_Sports&Outdoors_bestsellers',       hint: 'sports-fitness',           weight: 2 },
  { name: 'DS_ConsumerElectronics_bestsellers',   hint: 'electronics-tv-audio',     weight: 3 },
  { name: 'DS_Home&Kitchen_bestsellers',          hint: 'home-kitchen',             weight: 2 },
  { name: 'DS_Automobile&Accessories_bestsellers',hint: 'automotive-accessories',   weight: 2 },
  { name: 'DS_Sports-Clothing&Shoes',             hint: 'fashion-sportswear',       weight: 1 },
  { name: 'DS_DentalEquipment&Supplies',          hint: 'beauty-tools',             weight: 1 },
  { name: 'AEB_ ComputerAccessories_EG',          hint: 'electronics-computers',    weight: 2 },
  { name: 'AEB_ PhoneAccessories_EG',             hint: 'electronics-phones',       weight: 2 },
  { name: 'AEB_ SummerProducts_EG',               hint: null,                       weight: 1 },
];

function signParams(params) {
  const input = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', APP_SECRET).update(input, 'utf8').digest('hex').toUpperCase();
}

function isRetryable(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('rate') || s.includes('limit') || s.includes('flow') || s.includes('frequen')
      || s.includes('timeout') || s.includes('busy') || s.includes('try again')
      || s.includes('502') || s.includes('503');
}

function parseBanSeconds(msg) {
  const m = String(msg || '').match(/(\d+)\s*seconds?/i);
  if (!m) return 0;
  const seconds = parseInt(m[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(24 * 60 * 60, seconds + 10) : 0;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAE(method, params = {}, { retries = 3, baseDelayMs = 2000 } = {}) {
  let attempt = 0;
  while (true) {
    const all = {
      app_key: APP_KEY, method, session: TOKEN, sign_method: 'sha256',
      timestamp: new Date().toISOString().replace(/\.\d+Z/, '+0000').replace('T', ' '),
      v: '2.0', format: 'json',
    };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) all[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    all.sign = signParams(all);
    const u = new URL('https://api-sg.aliexpress.com/sync');
    u.search = new URLSearchParams(all).toString();
    let json;
    try {
      const res = await fetch(u, { method: 'POST', signal: AbortSignal.timeout(30000) });
      json = await res.json();
    } catch (err) {
      if (attempt < retries) { await sleep(baseDelayMs * 2 ** attempt); attempt++; continue; }
      throw err;
    }
    if (json.error_response) {
      const msg = json.error_response.msg || json.error_response.sub_msg || 'AE error';
      const ban = parseBanSeconds(msg);
      if (ban >= 300) {
        const err = new Error(msg); err.isBan = true; err.banSeconds = ban; throw err;
      }
      if (attempt < retries && isRetryable(msg)) {
        await sleep(baseDelayMs * 2 ** attempt); attempt++; continue;
      }
      const err = new Error(msg); err.code = json.error_response.code; throw err;
    }
    return json;
  }
}

function extractIds(resp) {
  const out = [];
  const result = resp?.aliexpress_ds_recommend_feed_get_response?.result;
  if (!result) return out;
  // products may be {} (empty) or {traffic_product_dto:[...]} or array forms
  const prods = result.products;
  if (!prods || typeof prods !== 'object') return out;
  const arr = Array.isArray(prods) ? prods : (Object.values(prods)[0] || []);
  const list = Array.isArray(arr) ? arr : [arr];
  for (const p of list) {
    if (!p) continue;
    const id = p.product_id ?? p.productId ?? p.item_id;
    if (id == null) continue;
    const s = String(id).trim();
    if (/^\d{6,}$/.test(s)) out.push(s);
  }
  return out;
}

async function loadKnownIds() {
  const known = new Set();
  const j = await pool.query(`SELECT product_id FROM ae_import_jobs`);
  for (const r of j.rows) known.add(String(r.product_id));
  const mp = await pool.query(
    `SELECT metadata->>'ae_product_id' AS pid FROM marketplace_products WHERE metadata ? 'ae_product_id'`
  );
  for (const r of mp.rows) if (r.pid) known.add(String(r.pid));
  return known;
}

async function mineFeed(feed, known, collected) {
  let added = 0, fetched = 0;
  for (let page = 1; page <= PAGES_PER_FEED; page++) {
    if (collected.size >= MAX_TOTAL) break;
    if (added >= MAX_PER_FEED) break;
    let resp;
    try {
      resp = await callAE('aliexpress.ds.recommend.feed.get', {
        feed_name: feed.name,
        country: COUNTRY, target_language: LANGUAGE, target_currency: CURRENCY,
        page_no: page, page_size: PAGE_SIZE,
      });
    } catch (e) {
      if (e.isBan) throw e;
      console.warn(`  [${feed.name}] page ${page} fail: ${e.message}`);
      break;
    }
    const result = resp.aliexpress_ds_recommend_feed_get_response?.result || {};
    const ids = extractIds(resp);
    fetched += ids.length;
    for (const id of ids) {
      if (collected.size >= MAX_TOTAL) break;
      if (added >= MAX_PER_FEED) break;
      if (known.has(id) || collected.has(id)) continue;
      collected.set(id, { hint: feed.hint, source: `hot_${feed.name}` });
      added++;
    }
    if (result.is_finished || ids.length === 0) break;
    await sleep(300);
  }
  return { added, fetched };
}

async function main() {
  console.log(`[hot-plan] out=${OUT_FILE} dry=${DRY} pages/feed=${PAGES_PER_FEED} max/feed=${MAX_PER_FEED} max_total=${MAX_TOTAL}`);

  let feeds = PREFERRED_FEEDS;
  if (EXPLICIT_FEEDS.length) {
    feeds = EXPLICIT_FEEDS.map(n => ({ name: n, hint: null, weight: 1 }));
    console.log(`[hot-plan] using explicit feeds: ${feeds.map(f => f.name).join(', ')}`);
  }

  const known = await loadKnownIds();
  console.log(`[hot-plan] known IDs already in DB: ${known.size}`);

  const collected = new Map();
  for (const feed of feeds) {
    if (collected.size >= MAX_TOTAL) break;
    try {
      const { added, fetched } = await mineFeed(feed, known, collected);
      console.log(`[${feed.name.padEnd(50)}] fetched=${fetched} new=${added} cum=${collected.size}`);
    } catch (e) {
      if (e.isBan) {
        console.error(`[hot-plan] AE BAN ${e.banSeconds}s — stopping mining`);
        break;
      }
      console.warn(`[${feed.name}] error: ${e.message}`);
    }
  }

  console.log(`\n[hot-plan] TOTAL NEW IDS: ${collected.size}`);
  if (DRY) { console.log('[hot-plan] DRY: not writing'); await pool.end(); return; }
  if (!collected.size) { console.log('[hot-plan] nothing to write'); await pool.end(); return; }

  const lines = [];
  for (const [id, meta] of collected.entries()) {
    lines.push(JSON.stringify({
      product_id: id, category_hint: meta.hint, source_files: [meta.source],
    }));
  }
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`[hot-plan] wrote ${lines.length} IDs → ${OUT_FILE}`);
  await pool.end();
}

main().catch(async e => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
