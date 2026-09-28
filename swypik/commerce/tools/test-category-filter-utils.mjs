import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sourcePath = path.join(process.cwd(), "lib", "db", "category-filter-utils.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const module = { exports: {} };
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require,
});

const { buildScopedTagId, parseScopedTagFilter } = module.exports;

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

assert.equal(
  buildScopedTagId(["Socks", " socks ", "", "Boxer Briefs"], 200000343),
  "tag:socks|boxer briefs|__root:200000343",
);

assertJsonEqual(parseScopedTagFilter("socks|boxer briefs|__root:200000343"), {
  tags: ["socks", "boxer briefs"],
  rootIds: ["200000343"],
});

assertJsonEqual(parseScopedTagFilter("briefs|__root:"), {
  tags: ["briefs"],
  rootIds: [],
});

assertJsonEqual(parseScopedTagFilter(""), {
  tags: [],
  rootIds: [],
});
