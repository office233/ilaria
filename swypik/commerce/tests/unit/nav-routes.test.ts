import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOTTOM_NAV, LEGAL_LINKS, NAV_MODULES } from "@/lib/nav/modules";

/**
 * Registrul de navigare nu are voie să trimită spre rute șterse: fiecare rută
 * (modul, CTA „Devino …", BottomNav, linkuri legale) trebuie să aibă un fișier
 * `page.tsx` în app/ — cu grupurile `(x)` ignorate, `[locale]` ca prefix opțional
 * și segmentele dinamice `[id]` / `[...slug]` acceptând orice.
 */

const APP_DIR = resolve(__dirname, "../../app");
const PAGE_FILES = new Set(["page.tsx", "page.ts", "page.jsx", "page.js"]);

function collectPagePatterns(dir: string, segments: string[] = [], out: string[][] = []): string[][] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api" && segments.length === 0) continue;
      if (name.startsWith("_") || name.startsWith("@")) continue;
      collectPagePatterns(full, [...segments, name], out);
    } else if (PAGE_FILES.has(name)) {
      out.push(segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))));
    }
  }
  return out;
}

const PATTERNS = collectPagePatterns(APP_DIR).map((segs) => (segs[0] === "[locale]" ? segs.slice(1) : segs));

function matches(pattern: string[], parts: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.startsWith("[[...")) return true;
    if (seg.startsWith("[...")) return parts.length > i;
    if (i >= parts.length) return false;
    if (seg.startsWith("[") && seg.endsWith("]")) continue;
    if (seg !== parts[i]) return false;
  }
  return pattern.length === parts.length;
}

export function routeExists(route: string): boolean {
  const parts = route.split(/[?#]/)[0].split("/").filter(Boolean);
  return PATTERNS.some((p) => matches(p, parts));
}

describe("registrul de navigare → rute existente", () => {
  it("scannerul vede paginile cunoscute și respinge rute inexistente", () => {
    expect(routeExists("/")).toBe(true);
    expect(routeExists("/explore")).toBe(true);
    expect(routeExists("/u/ana")).toBe(true);
    expect(routeExists("/admin")).toBe(true);
    expect(routeExists("/nu-exista-niciodata")).toBe(false);
    expect(routeExists("/apps")).toBe(false);
    expect(routeExists("/developers")).toBe(false);
  });

  const routes = [
    ...NAV_MODULES.map((m) => [`module:${m.id}`, m.route] as const),
    ...NAV_MODULES.filter((m) => m.become).map((m) => [`become:${m.id}`, m.become!.route] as const),
    ...BOTTOM_NAV.map((b) => [`bottom:${b.key}`, b.route] as const),
    ...LEGAL_LINKS.filter((l) => l.route).map((l) => [`legal:${l.key}`, l.route!] as const),
  ];

  it.each(routes)("%s → %s are pagină", (_id, route) => {
    expect(routeExists(route)).toBe(true);
  });

  it("intrările cerute de module sunt în registru", () => {
    const byId = new Map(NAV_MODULES.map((m) => [m.id, m]));
    expect(byId.get("host")).toMatchObject({ route: "/stays/manage", group: "business", roles: ["host"], flag: "stays" });
    expect(byId.get("myStays")).toMatchObject({ route: "/account/stays", group: "settings", flag: "stays" });
    expect(byId.get("liveStudio")).toMatchObject({ route: "/creator/live", roles: ["creator"], flag: "live" });
    expect(byId.get("messages")?.route).toBe("/inbox");
  });
});
