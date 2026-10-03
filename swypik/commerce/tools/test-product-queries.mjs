import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, stubs = {}) {
  const sourcePath = path.join(process.cwd(), relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in stubs) return stubs[id];
    return require(id);
  };

  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  });

  return module.exports;
}

const categoryUtils = loadTsModule("lib/db/category-filter-utils.ts");
const productQueries = loadTsModule("lib/db/product-queries.ts", {
  "@/lib/db": { dbQuery: () => { throw new Error("dbQuery should not run in unit tests"); } },
  "@/lib/db/category-filter-utils": categoryUtils,
});

const {
  buildCategoryHierarchyForTest,
  buildSearchFiltersForTest,
  mapCategoryRowForTest,
} = productQueries;

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const numericFilters = buildSearchFiltersForTest({ categoryId: "200000343" });
const numericSql = numericFilters.where.join("\n");
assert.match(numericSql, /p\.metadata->>'ae_category_id'/);
assert.match(numericSql, /ar\.ae_category_id::text/);
assert.doesNotMatch(numericSql, /product_type[^)]*IS NULL/i);
assertJsonEqual(numericFilters.params, ["200000343"]);

const categorySql = buildSearchFiltersForTest({ category: "hoodie" }).where.join("\n");
const tagSql = buildSearchFiltersForTest({ tag: "hoodie|__root:200000343" });
const syntheticRootTagSql = buildSearchFiltersForTest({ tag: "socks|__root:root:apparel" });
for (const expected of [
  "p.metadata->>'product_type'",
  "ap.product_type",
  "p.category",
  "p.metadata->>'ae_root_category_name'",
  "ar.name",
]) {
  const pattern = new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.match(categorySql, pattern);
  assert.match(tagSql.where.join("\n"), pattern);
}
assert.match(tagSql.where.join("\n"), /ae_root_category_id/);
assertJsonEqual(tagSql.params, ["%hoodie%", "200000343"]);
assert.match(syntheticRootTagSql.where.join("\n"), /200000343/);
assertJsonEqual(syntheticRootTagSql.params, ["%socks%"]);

assertJsonEqual(
  mapCategoryRowForTest(
    { category_id: "tag:hoodies", name_en: "Hoodies", name_ro: "Hanorace", count: "12" },
    "ro",
  ),
  {
    id: "tag:hoodies",
    name: "Hanorace",
    nameEn: "Hoodies",
    count: 12,
  },
);

const hierarchy = buildCategoryHierarchyForTest(
  [
    {
      root_id: "18",
      root_name: "Sports & Entertainment",
      root_name_ro: "Sport & Divertisment",
      tag_en: "T-Shirts",
      tag_ro: "Tricouri",
      leaf_id: "1001",
      leaf_name: "Cycling Jerseys",
      leaf_name_ro: "Tricouri ciclism",
      count: 4,
    },
  ],
  "en",
);

assert.equal(hierarchy[0].id, "18");
assert.equal(hierarchy[0].name, "Sports & Entertainment");
assert.equal(hierarchy[0].children[0].id, "tag:t-shirts|__root:18");

const longNumericRootHierarchy = buildCategoryHierarchyForTest(
  [
    {
      root_id: "200000343",
      root_name: "Men's Clothing",
      root_name_ro: "Îmbrăcăminte Bărbați",
      tag_en: "Socks",
      tag_ro: "Șosete",
      leaf_id: "200000384",
      leaf_name: "Socks",
      leaf_name_ro: "Șosete",
      count: 845,
    },
  ],
  "ro",
);

assert.equal(longNumericRootHierarchy[0].id, "200000343");
assert.equal(longNumericRootHierarchy[0].name, "Îmbrăcăminte Bărbați");
assert.equal(longNumericRootHierarchy[0].children[0].id, "tag:socks|__root:200000343");
