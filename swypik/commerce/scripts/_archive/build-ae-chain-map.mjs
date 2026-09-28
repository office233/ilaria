#!/usr/bin/env node
// Build/refresh ae_category_full_chain by probing aliexpress.ds.text.search
// per root, using known leaf names from ae_categories as keywords.
// Discovers full 3-4 level chains (incl. intermediate IDs missing from ae_categories).

import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

// ---- env ----
const envText = fs.readFileSync('/opt/swypik/worktrees/catalog-clean/infra/hetzner/.env.production', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;
const TOKEN = process.env.ALIEXPRESS_ACCESS_TOKEN;
if (!APP_KEY || !APP_SECRET || !TOKEN) throw new Error('missing AE creds');

// localhost via docker network: container exposes 5432 on host
const DB_URL = (process.env.DATABASE_URL || '')
  .replace('@postgres:', '@127.0.0.1:');
const pool = new pg.Pool({ connectionString: DB_URL });

// ---- AE client ----
function sign(params) {
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha256', APP_SECRET).update(sorted, 'utf8').digest('hex').toUpperCase();
}
function tsNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, '+0000').replace('T', ' ');
}
async function callAE(method, params = {}) {
  const all = {
    app_key: APP_KEY, method, session: TOKEN,
    sign_method: 'sha256', timestamp: tsNow(), v: '2.0', format: 'json',
  };
  for (const [k, v] of Object.entries(params)) if (v != null) all[k] = String(v);
  all.sign = sign(all);
  const url = new URL('https://api-sg.aliexpress.com/sync');
  url.search = new URLSearchParams(all).toString();
  const r = await fetch(url, { method: 'POST' });
  return r.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- main ----
async function main() {
  const startRoot = process.argv[2] ? Number(process.argv[2]) : null;
  const limitPerRoot = process.argv[3] ? Number(process.argv[3]) : 6;

  // Load roots & their leaf names
  const { rows: roots } = await pool.query(
    `SELECT ae_category_id::bigint AS id, name FROM ae_categories WHERE level=1 ORDER BY ae_category_id`
  );
  const { rows: leaves } = await pool.query(
    `SELECT ae_category_id::bigint AS id, parent_id::bigint AS pid, name
     FROM ae_categories WHERE level=2 ORDER BY parent_id, ae_category_id`
  );
  const leavesByRoot = new Map();
  for (const r of roots) leavesByRoot.set(String(r.id), []);
  for (const l of leaves) {
    const arr = leavesByRoot.get(String(l.pid));
    if (arr) arr.push(l);
  }
  // Pre-load known names map (level 1 + 2)
  const nameByIdEn = new Map();
  const { rows: allCats } = await pool.query(
    `SELECT ae_category_id::bigint AS id, name, name_ro FROM ae_categories`
  );
  const nameByIdRo = new Map();
  for (const c of allCats) {
    nameByIdEn.set(String(c.id), c.name || '');
    nameByIdRo.set(String(c.id), c.name_ro || c.name || '');
  }

  const totalRoots = startRoot ? 1 : roots.length;
  let rootIdx = 0;
  let totalChains = 0;
  let totalNew = 0;

  for (const root of roots) {
    if (startRoot && Number(root.id) !== startRoot) continue;
    rootIdx++;

    // Pick keywords: root name (split words) + first N leaf names
    const rootWords = root.name.split(/[\s,&\/]+/).filter(w => w.length >= 4).slice(0, 2);
    const leafNames = (leavesByRoot.get(String(root.id)) || [])
      .map(l => l.name)
      .filter(n => n && n.length >= 3)
      .slice(0, limitPerRoot);
    const keywords = [...new Set([...rootWords, ...leafNames])].slice(0, limitPerRoot + 2);

    console.log(`\n[${rootIdx}/${totalRoots}] root=${root.id} (${root.name})  keywords=${keywords.length}`);
    const chainsForRoot = new Map(); // leafId -> chainIds[]

    for (const kw of keywords) {
      try {
        const r = await callAE('aliexpress.ds.text.search', {
          keyWord: kw, categoryId: String(root.id),
          pageSize: 50, countryCode: 'RO', currency: 'USD',
          language: 'EN', local: 'en_US',
        });
        const items = r.aliexpress_ds_text_search_response?.data?.products?.selection_search_product || [];
        const errMsg = r.error_response?.msg;
        if (errMsg) console.log(`   kw="${kw}" ERR ${errMsg}`);
        let newInBatch = 0;
        for (const it of items) {
          const cateId = it.cateId;
          if (!cateId) continue;
          const ids = String(cateId).split(',').map(s => s.trim()).filter(Boolean);
          if (ids.length < 2) continue;
          if (String(ids[0]) !== String(root.id)) continue; // sanity
          const leafId = ids[ids.length - 1];
          if (!chainsForRoot.has(leafId)) {
            chainsForRoot.set(leafId, ids);
            newInBatch++;
          }
        }
        console.log(`   kw="${kw}" items=${items.length} newChains=${newInBatch}`);
      } catch (e) {
        console.log(`   kw="${kw}" THROW ${e.message}`);
      }
      await sleep(2500);
    }

    // upsert
    let inserted = 0, updated = 0;
    for (const [leafId, ids] of chainsForRoot) {
      const chainIds = ids.map(s => Number(s));
      const namesEn = ids.map(id => nameByIdEn.get(id) || null);
      const namesRo = ids.map(id => nameByIdRo.get(id) || nameByIdEn.get(id) || null);
      const depth = ids.length;
      const rootId = Number(ids[0]);
      const res = await pool.query(
        `INSERT INTO ae_category_full_chain
           (leaf_id, chain_ids, chain_names_en, chain_names_ro, depth, root_id, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text.search', now())
         ON CONFLICT (leaf_id) DO UPDATE
           SET chain_ids = EXCLUDED.chain_ids,
               chain_names_en = EXCLUDED.chain_names_en,
               chain_names_ro = EXCLUDED.chain_names_ro,
               depth = EXCLUDED.depth,
               root_id = EXCLUDED.root_id,
               updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [Number(leafId), chainIds, namesEn, namesRo, depth, rootId]
      );
      if (res.rows[0].inserted) inserted++; else updated++;
    }
    console.log(`   => chains discovered=${chainsForRoot.size}  inserted=${inserted}  updated=${updated}`);
    totalChains += chainsForRoot.size;
    totalNew += inserted;
  }

  console.log(`\nDONE. roots processed=${rootIdx}  total chains=${totalChains}  new rows=${totalNew}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
