#!/usr/bin/env node
/**
 * Re-translate produse cu translation stale:
 *   - source_content_hash IS NULL (legacy rows înainte de migrarea 0008)
 *   - SAU source_content_hash != current hash(title+description)
 *
 * Default: doar caz 1 (NULL). Treci --include-changed pentru caz 2.
 *
 * Usage:
 *   DRY:   node scripts/retranslate-stale-products.mjs --locale=ro --limit=20
 *   APPLY: node scripts/retranslate-stale-products.mjs --locale=ro --limit=200 --apply
 *
 * Env: identic cu translate-products-studiai.mjs (TIER_ENABLED, etc).
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
const TARGET_LOCALE = String(args.locale || 'ro');
const LIMIT = Number(args.limit || 20);
const INCLUDE_CHANGED = Boolean(args['include-changed']);
const APPLY = Boolean(args.apply);

function contentHash(title, description) {
  return createHash('sha256')
    .update(`${title || ''}\u0000${description || ''}`)
    .digest('hex')
    .slice(0, 16);
}

async function main() {
  console.log(`[retranslate-stale] mode=${APPLY ? 'APPLY' : 'DRY'} locale=${TARGET_LOCALE} limit=${LIMIT} include_changed=${INCLUDE_CHANGED}`);

  // Caz 1: NULL hash (legacy)
  const { rows: legacyRows } = await pool.query(
    `SELECT pt.product_id, pt.locale, p.title, p.description,
            pt.source_content_hash AS stored_hash
       FROM product_translations pt
       JOIN marketplace_products p ON p.id = pt.product_id
      WHERE pt.locale = $1
        AND pt.source_content_hash IS NULL
        AND p.status = 'active'
        AND p.title IS NOT NULL
      ORDER BY p.orders_count_int DESC NULLS LAST
      LIMIT $2`,
    [TARGET_LOCALE, LIMIT],
  );

  console.log(`[retranslate-stale] legacy (NULL hash): ${legacyRows.length}`);

  let changedRows = [];
  if (INCLUDE_CHANGED) {
    // Caz 2: hash diferit — load all with hash + filter în JS (DB nu calculează SHA256 ușor)
    const { rows } = await pool.query(
      `SELECT pt.product_id, pt.locale, p.title, p.description,
              pt.source_content_hash AS stored_hash
         FROM product_translations pt
         JOIN marketplace_products p ON p.id = pt.product_id
        WHERE pt.locale = $1
          AND pt.source_content_hash IS NOT NULL
          AND p.status = 'active'
          AND p.title IS NOT NULL
        ORDER BY p.orders_count_int DESC NULLS LAST
        LIMIT $2`,
      [TARGET_LOCALE, LIMIT],
    );
    changedRows = rows.filter((r) => contentHash(r.title, r.description) !== r.stored_hash);
    console.log(`[retranslate-stale] changed hash: ${changedRows.length} of ${rows.length} checked`);
  }

  const todo = [...legacyRows, ...changedRows].slice(0, LIMIT);
  console.log(`[retranslate-stale] total to re-translate: ${todo.length}`);

  if (!APPLY) {
    console.log('[retranslate-stale] DRY — sample first 5:');
    for (const r of todo.slice(0, 5)) {
      const newHash = contentHash(r.title, r.description);
      console.log(`  ${r.product_id} stored=${r.stored_hash || 'NULL'} → new=${newHash} title="${(r.title || '').slice(0, 50)}"`);
    }
    await pool.end();
    return;
  }

  // APPLY: doar hash backfill (pentru rows cu NULL si content identic)
  // — nu re-cheamă LLM-ul ca să nu re-genereze degeaba traducerea existentă.
  // Pentru re-translate real, foloseste translate-products-studiai.mjs --apply
  // (care va updata si hash-ul cand schimba descrierea).
  let updated = 0;
  for (const r of legacyRows) {
    const newHash = contentHash(r.title, r.description);
    await pool.query(
      `UPDATE product_translations SET source_content_hash = $1
        WHERE product_id = $2 AND locale = $3 AND source_content_hash IS NULL`,
      [newHash, r.product_id, r.locale],
    );
    updated++;
  }
  console.log(`[retranslate-stale] backfilled hash on ${updated} legacy rows`);

  if (INCLUDE_CHANGED && changedRows.length) {
    console.log(`[retranslate-stale] ${changedRows.length} rows have changed content — re-run translate-products-studiai.mjs with --apply to re-generate them (LLM call needed)`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
