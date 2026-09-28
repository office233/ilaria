import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const sql = readFileSync(path.resolve(__dirname, "../../db/migrations/20260927_0030_perf_indexes.sql"), "utf8");
/** SQL fără comentariile `--` (secțiunea de rollback din antet conține DROP-uri comentate). */
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const statements = code
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("migrarea 20260927_0030_perf_indexes", () => {
  it("conține doar CREATE INDEX IF NOT EXISTS", () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).toMatch(/^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+\w+/i);
    }
  });

  it("nu folosește CONCURRENTLY (se aplică într-o tranzacție)", () => {
    expect(code).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("nu modifică date sau obiecte existente", () => {
    expect(code).not.toMatch(/\b(DROP|ALTER\s+TABLE|DELETE|UPDATE|TRUNCATE|INSERT)\b/i);
  });

  it("nu deschide o tranzacție proprie (apply-migration.sh o face)", () => {
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
  });

  it("antetul are câte un DROP INDEX IF EXISTS de rollback pentru fiecare index", () => {
    const created = [...code.matchAll(/INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    for (const name of created) {
      expect(sql).toMatch(new RegExp(`--\\s*DROP INDEX IF EXISTS ${name};`));
    }
  });
});
