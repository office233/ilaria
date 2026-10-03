// Test the taxonomy resolver against the full /tmp/ae_test_fixture.json file.
// Loads ae_categories from DB, runs resolver on all 82 entries, writes
// /tmp/ae_mapping_result.json + prints a distribution report.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolveTaxonomy, loadCategories } from '../lib/aliexpress/taxonomy-resolver.mjs';

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
  // Convert container-host to localhost.
  u = u.replace(/@postgres:/, '@localhost:').replace(/@swypik-prod-postgres-1:/, '@localhost:');
  return u;
}

loadEnv();

const fixturePath = process.argv[2] || '/tmp/ae_test_fixture.json';
const outPath = process.argv[3] || '/tmp/ae_mapping_result.json';

let raw = fs.readFileSync(fixturePath, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const fixture = JSON.parse(raw);

const pool = new Pool({ connectionString: hostDbUrl() });
const cats = await loadCategories(pool);
console.log(`Loaded ${cats.size} ae_categories`);

const results = [];
const dist = { byDept: {}, byCanonical: {}, byReason: {} };
for (const e of fixture) {
  const r = resolveTaxonomy({
    displayName: e.display_name,
    labelHint: e.label_hint,
    postCatIds: e.post_cat_ids,
    leafCatId: e.leaf_cat_id,
  }, cats);
  results.push({ product_id: e.product_id, file: e.file, input: e, resolved: r });
  dist.byDept[r.department] = (dist.byDept[r.department] || 0) + 1;
  dist.byCanonical[r.canonical] = (dist.byCanonical[r.canonical] || 0) + 1;
  dist.byReason[r.reason] = (dist.byReason[r.reason] || 0) + 1;
}

fs.writeFileSync(outPath, JSON.stringify({ count: results.length, distribution: dist, results }, null, 2));
console.log(`\nWrote ${results.length} mappings to ${outPath}`);
console.log('\n== Distribution by department ==');
console.log(JSON.stringify(dist.byDept, null, 2));
console.log('\n== Distribution by reason (resolver confidence path) ==');
console.log(JSON.stringify(dist.byReason, null, 2));
console.log('\n== First 25 mappings ==');
for (const r of results.slice(0, 25)) {
  console.log(`  ${String(r.product_id).padEnd(18)} ${String(r.input.display_name||'').padEnd(28)} → ${r.resolved.canonical}  [${r.resolved.reason}]`);
}
const otherMisc = results.filter((r) => r.resolved.canonical.startsWith('Other > Misc'));
console.log(`\nFallback (Other > Misc) count: ${otherMisc.length} / ${results.length}  (${(otherMisc.length*100/results.length).toFixed(1)}%)`);
if (otherMisc.length) {
  console.log('Fallbacks:');
  for (const r of otherMisc) console.log(`  ${r.product_id} ${r.input.display_name} hints=${JSON.stringify(r.input.post_cat_ids)}`);
}

await pool.end();
