#!/usr/bin/env node
/**
 * Bulk backfill source_content_hash pentru product_translations cu hash NULL.
 *
 * Folosește același algoritm ca translate-products-studiai.mjs:
 *   sha256(title + \u0000 + description).slice(0, 16)
 *
 * Procesează în batches de 500 rows × N batches pana se termina.
 *
 * Usage:
 *   DRY:   node scripts/backfill-translation-hash.mjs
 *   APPLY: node scripts/backfill-translation-hash.mjs --apply
 *   doar 1 locale: --locale=ro
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL });

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const APPLY = Boolean(args.apply);
const LOCALE_FILTER = args.locale || null;
const BATCH = Number(args.batch || 500);

function contentHash(title, description) {
  return createHash('sha256')
    .update(`${title || ''}\u0000${description || ''}`)
    .digest('hex')
    .slice(0, 16);
}

async function main() {
  const localeWhere = LOCALE_FILTER ? `AND pt.locale = '${LOCALE_FILTER}'` : '';

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n FROM product_translations pt WHERE pt.source_content_hash IS NULL ${localeWhere ? localeWhere.replace('pt.', '') : ''}`,
  );
  const totalToProcess = countRows[0].n;
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY'} locale=${LOCALE_FILTER || 'all'} batch=${BATCH} pending=${totalToProcess}`);

  if (!totalToProcess) { await pool.end(); return; }

  let processed = 0;
  let updated = 0;
  let startTs = Date.now();

  while (processed < totalToProcess) {
    const { rows } = await pool.query(
      `SELECT pt.product_id, pt.locale, p.title, p.description
         FROM product_translations pt
         JOIN marketplace_products p ON p.id = pt.product_id
        WHERE pt.source_content_hash IS NULL ${localeWhere}
        LIMIT $1`,
      [BATCH],
    );
    if (!rows.length) break;

    if (!APPLY) {
      console.log(`[backfill] DRY would update ${rows.length} rows (sample first 3):`);
      for (const r of rows.slice(0, 3)) {
        console.log(`  ${r.product_id} ${r.locale} → ${contentHash(r.title, r.description)} title="${(r.title || '').slice(0, 40)}"`);
      }
      break;
    }

    // Bulk UPDATE via unnest 3 arrays (product_id, locale, hash)
    const pids = rows.map((r) => r.product_id);
    const locs = rows.map((r) => r.locale);
    const hashes = rows.map((r) => contentHash(r.title, r.description));
    const res = await pool.query(
      `UPDATE product_translations pt
          SET source_content_hash = u.h
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS u(pid, loc, h)
        WHERE pt.product_id = u.pid AND pt.locale = u.loc
          AND pt.source_content_hash IS NULL`,
      [pids, locs, hashes],
    );
    updated += res.rowCount;
    processed += rows.length;

    const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
    const rate = (processed / elapsed).toFixed(0);
    console.log(`[backfill] processed=${processed}/${totalToProcess} updated=${updated} elapsed=${elapsed}s rate=${rate}/s`);
  }

  console.log(`[backfill] DONE updated=${updated} of pending=${totalToProcess}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
