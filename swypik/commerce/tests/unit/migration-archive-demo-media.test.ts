import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const sql = readFileSync(path.resolve(__dirname, "../../db/migrations/20260927_0001_archive_demo_media.sql"), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("migrarea 20260927_0001_archive_demo_media", () => {
  it("nu șterge nimic (fără DELETE / DROP / TRUNCATE)", () => {
    expect(code).not.toMatch(/\b(DELETE\s+FROM|DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE)\b/i);
  });

  it("e one-shot: iese imediat dacă marcajul `_run` există și îl scrie la final", () => {
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM data_cleanup_archive WHERE batch = v_batch AND table_name = '_run'\)/);
    expect(code).toMatch(/VALUES \(v_batch, '_run', 'marker'/);
  });

  it("salvează valorile vechi înainte de orice UPDATE și atinge doar host-urile vechi de storage", () => {
    const firstInsert = code.indexOf("INSERT INTO data_cleanup_archive");
    const firstUpdate = code.indexOf("UPDATE videos");
    expect(firstInsert).toBeGreaterThan(-1);
    expect(firstInsert).toBeLessThan(firstUpdate);
    const hostPattern = /v_old_host CONSTANT text :=\s*'([^']+)'/.exec(code)?.[1];
    expect(hostPattern).toBeTruthy();
    const re = new RegExp(hostPattern!, "i");
    expect(re.test("https://cdn.swypik.com/a.jpg")).toBe(true);
    expect(re.test("http://swypik-minio:9000/video/a.jpg")).toBe(true);
    expect(re.test("/media/a.jpg")).toBe(true);
    expect(re.test("https://lh3.googleusercontent.com/a.jpg")).toBe(false);
    expect(re.test("https://media.swypik.community/a.jpg")).toBe(false);
  });
});
