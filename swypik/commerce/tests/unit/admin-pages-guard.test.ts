import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Regresie (audit 2026-09-28, P0): 12 pagini server din /admin nu aveau gardă
 * proprie. Layout-ul nu e o gardă suficientă — Next îl sare la cererile RSC
 * parțiale, iar middleware-ul verifică doar că există cookie-ul admin_token.
 * Cu un cookie fals + header `RSC: 1` paginile se randau cu date din DB.
 *
 * Regula: orice pagină SERVER din app/(site)/admin cheamă requireAdminPage()
 * (sau getAdminActor/requireAdminSession). Paginile client iau datele prin API-uri,
 * care au garda lor.
 */
const ADMIN_DIR = join(__dirname, "..", "..", "app", "(site)", "admin");
const GUARD = /requireAdminPage\(|requireAdminSession\(|assertAdminSession\(|getAdminActor\(/;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return pages(full);
    return e === "page.tsx" ? [full] : [];
  });
}

describe("paginile server din /admin au gardă proprie", () => {
  const all = pages(ADMIN_DIR);

  it("găsește paginile de admin", () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it("nicio pagină server fără requireAdminPage", () => {
    const missing = all.filter((f) => {
      const src = readFileSync(f, "utf8");
      const isClient = /^\s*["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n"));
      return !isClient && !GUARD.test(src);
    });
    expect(missing.map((f) => relative(ADMIN_DIR, f).split(sep).join("/"))).toEqual([]);
  });
});
