// Re-map taxonomy for existing AliExpress products in marketplace_products
// using the new taxonomy resolver + the audit fixture.
//
// Usage:
//   node scripts/ae-fix-existing-taxonomy.mjs                # dry run
//   node scripts/ae-fix-existing-taxonomy.mjs --apply        # actually UPDATE
//   node scripts/ae-fix-existing-taxonomy.mjs --fixture=path # custom fixture
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolveTaxonomy, loadCategories, slugify } from '../lib/aliexpress/taxonomy-resolver.mjs';

const require = createRequire('/opt/swypik/app/package.json');
const { Pool } = require('pg');

function loadEnv() {
  const txt = fs.readFileSync('/opt/swypik/app/infra/hetzner/.env.production', 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
function hostDbUrl() {
  let u = process.env.DATABASE_URL || '';
  return u.replace(/@postgres:/, '@localhost:').replace(/@swypik-prod-postgres-1:/, '@localhost:');
}

loadEnv();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fixturePath = (args.find((a) => a.startsWith('--fixture=')) || '--fixture=/tmp/ae_test_fixture.json').split('=')[1];

let raw = fs.readFileSync(fixturePath, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const fixture = JSON.parse(raw);
console.log(`Fixture: ${fixture.length} entries from ${fixturePath}`);
console.log(`Mode: ${apply ? 'APPLY (will UPDATE rows)' : 'DRY RUN'}`);

const pool = new Pool({ connectionString: hostDbUrl() });
const cats = await loadCategories(pool);
console.log(`Loaded ${cats.size} ae_categories`);

const stats = { updated: 0, notFound: 0, unchanged: 0, errors: 0 };
const samples = [];

for (const e of fixture) {
  const r = resolveTaxonomy({
    displayName: e.display_name,
    labelHint: e.label_hint,
    postCatIds: e.post_cat_ids,
    leafCatId: e.leaf_cat_id,
  }, cats);

  // Look up existing product in marketplace_products by AE product_id.
  const lookup = await pool.query(
    `SELECT id, taxonomy_department, taxonomy_category, taxonomy_subcategory, taxonomy_leaf, canonical_category, metadata
     FROM marketplace_products
     WHERE metadata->>'ae_product_id' = $1
        OR supplier_product_id = $1
     LIMIT 1`,
    [String(e.product_id)]
  );
  if (!lookup.rows.length) { stats.notFound++; continue; }
  const row = lookup.rows[0];

  // Compare canonical to detect change.
  const newCanonical = r.canonical;
  if (row.canonical_category === newCanonical
      && row.taxonomy_department === r.department
      && row.taxonomy_category === r.category
      && row.taxonomy_subcategory === r.subcategory
      && row.taxonomy_leaf === r.leaf) {
    stats.unchanged++;
    continue;
  }

  samples.push({
    id: row.id,
    ae_product_id: e.product_id,
    before: row.canonical_category,
    after: newCanonical,
    reason: r.reason,
  });

  if (apply) {
    try {
      const newMetadata = {
        ...(row.metadata || {}),
        ae_category_id: r.aeCategoryId,
        ae_root_category_id: r.aeRootCategoryId,
        ae_root_category_name: r.aeRootCategoryName,
        ae_category_name: r.leaf,
        taxonomy_resolver_version: 1,
        taxonomy_remapped_at: new Date().toISOString(),
      };
      await pool.query(
        `UPDATE marketplace_products SET
           taxonomy_department = $1,
           taxonomy_category = $2,
           taxonomy_subcategory = $3,
           taxonomy_leaf = $4,
           taxonomy_slug = $5,
           taxonomy_confidence = $6,
           taxonomy_reason = $7,
           canonical_category = $8,
           canonical_category_slug = $5,
           category = $8,
           metadata = $9::jsonb,
           updated_at = now()
         WHERE id = $10`,
        [r.department, r.category, r.subcategory, r.leaf, r.slug, r.confidence,
         `ae_resolver_${r.reason}`, r.canonical, JSON.stringify(newMetadata), row.id]
      );
      stats.updated++;
    } catch (err) {
      stats.errors++;
      console.error(`  ERR product_id=${e.product_id}: ${err.message}`);
    }
  } else {
    stats.updated++; // counted as would-update in dry-run
  }
}

console.log('\n== Summary ==');
console.log(JSON.stringify(stats, null, 2));
console.log(`\n== Sample changes (${Math.min(samples.length, 20)} of ${samples.length}) ==`);
for (const s of samples.slice(0, 20)) {
  console.log(`  ${String(s.ae_product_id).padEnd(18)} ${String(s.before||'(null)').padEnd(45)} → ${s.after}`);
}

await pool.end();
