import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  allowedGrowth,
  buildBaseline,
  collectRouteFiles,
  compareToBaseline,
  computeFirstLoad,
  formatTable,
  normalizeAppRoute,
  parseArgs,
} from "../../scripts/perf/budget-lib.mjs";

const KB = 1024;

/** Manifest fals în formatul Next 15 (App Router + shell-ul Pages implicit). */
const fixture = {
  buildManifest: {
    rootMainFiles: ["static/chunks/webpack.js", "static/chunks/framework.js", "static/chunks/main-app.js"],
    polyfillFiles: ["static/chunks/polyfills.js"],
    pages: {
      "/_app": ["static/chunks/webpack.js", "static/chunks/pages/_app.js"],
      "/_error": ["static/chunks/pages/_error.js"],
    },
  },
  appBuildManifest: {
    pages: {
      "/layout": ["static/chunks/webpack.js", "static/css/app.css", "static/chunks/app/layout.js"],
      "/[locale]/page": ["static/chunks/webpack.js", "static/chunks/shared.js", "static/chunks/app/home.js"],
      "/[locale]/(shop)/product/[id]/page": ["static/chunks/shared.js", "static/chunks/app/product.js"],
      "/api/health/route": ["static/chunks/webpack.js"],
      "/_not-found/page": ["static/chunks/app/not-found.js"],
    },
  },
};

const fileSizes: Record<string, number> = {
  "static/chunks/webpack.js": 2 * KB,
  "static/chunks/framework.js": 40 * KB,
  "static/chunks/main-app.js": 3 * KB,
  "static/chunks/polyfills.js": 30 * KB,
  "static/chunks/shared.js": 20 * KB,
  "static/chunks/app/home.js": 5 * KB,
  "static/chunks/app/product.js": 8 * KB,
  "static/chunks/app/not-found.js": 1 * KB,
};

describe("normalizeAppRoute", () => {
  it("scoate sufixul /page și grupurile de rute", () => {
    expect(normalizeAppRoute("/[locale]/(shop)/product/[id]/page")).toBe("/[locale]/product/[id]");
    expect(normalizeAppRoute("/page")).toBe("/");
    expect(normalizeAppRoute("/_not-found/page")).toBe("/_not-found");
  });
  it("ignoră layout-uri și route handlers", () => {
    expect(normalizeAppRoute("/layout")).toBeNull();
    expect(normalizeAppRoute("/api/health/route")).toBeNull();
    expect(normalizeAppRoute("/foo/pages")).toBeNull();
  });
});

describe("collectRouteFiles + computeFirstLoad", () => {
  const routes = collectRouteFiles(fixture);

  it("include doar paginile, cu rootMainFiles și fără CSS/polyfills/duplicate", () => {
    expect([...routes.keys()].sort()).toEqual(["/[locale]", "/[locale]/product/[id]", "/_not-found"]);
    const home = routes.get("/[locale]")!;
    expect(home).toContain("static/chunks/framework.js");
    expect(home.filter((f) => f === "static/chunks/webpack.js")).toHaveLength(1);
    expect(home.some((f) => f.endsWith(".css"))).toBe(false);
    expect(home).not.toContain("static/chunks/polyfills.js");
  });

  it("numără chunk-urile partajate la fiecare rută (gzip bytes)", () => {
    const { sizes, missing } = computeFirstLoad(routes, (f) => fileSizes[f] ?? null);
    expect(sizes["/[locale]"]).toBe((2 + 40 + 3 + 20 + 5) * KB);
    expect(sizes["/[locale]/product/[id]"]).toBe((2 + 40 + 3 + 20 + 8) * KB);
    expect(sizes["/_not-found"]).toBe((2 + 40 + 3 + 1) * KB);
    expect(missing).toEqual([]);
  });

  it("raportează fișierele lipsă și le numără 0", () => {
    const { sizes, missing } = computeFirstLoad(routes, (f) => (f.includes("shared") ? null : fileSizes[f]));
    expect(missing).toEqual(["static/chunks/shared.js"]);
    expect(sizes["/[locale]"]).toBe((2 + 40 + 3 + 5) * KB);
  });

  it("include rutele Pages Router cu shell-ul /_app", () => {
    const pagesOnly = collectRouteFiles({
      buildManifest: { pages: { "/_app": ["a.js"], "/_error": ["e.js"], "/legacy": ["l.js", "a.js"] } },
    });
    expect([...pagesOnly.entries()]).toEqual([["/legacy", ["a.js", "l.js"]]]);
  });
});

describe("compareToBaseline", () => {
  const opts = { tolerancePct: 5, toleranceKb: 5, capKb: 350 };

  it("toleranța = max(5%, 5 KB)", () => {
    expect(allowedGrowth(50 * KB, opts)).toBe(5 * KB);
    expect(allowedGrowth(200 * KB, opts)).toBe(10 * KB);
  });

  it("trece în toleranță, pică peste ea", () => {
    const base = { "/a": 200 * KB, "/b": 200 * KB };
    const res = compareToBaseline({ "/a": 209 * KB, "/b": 211 * KB }, base, opts);
    expect(res.ok).toBe(false);
    expect(res.failures.map((r) => r.route)).toEqual(["/b"]);
    expect(res.rows.find((r) => r.route === "/a")!.status).toBe("ok");
    expect(res.rows[0].route).toBe("/b"); // sortat după delta descrescător
  });

  it("rute noi: ok sub plafon, eșec peste plafon; rutele dispărute sunt doar raportate", () => {
    const res = compareToBaseline({ "/new": 100 * KB, "/huge": 400 * KB }, { "/gone": 10 * KB }, opts);
    const byRoute = Object.fromEntries(res.rows.map((r) => [r.route, r.status]));
    expect(byRoute).toEqual({ "/new": "new", "/huge": "new-over-cap", "/gone": "removed" });
    expect(res.failures.map((r) => r.route)).toEqual(["/huge"]);
  });

  it("scăderile sunt ok și folosesc valorile implicite fără opțiuni", () => {
    const res = compareToBaseline({ "/a": 100 * KB }, { "/a": 150 * KB });
    expect(res.ok).toBe(true);
    expect(res.rows[0].delta).toBe(-50 * KB);
  });
});

describe("formatTable", () => {
  it("afișează KB, delta cu semn și procent, status", () => {
    const { rows } = compareToBaseline({ "/a": 110 * KB, "/n": 1 * KB }, { "/a": 100 * KB }, DEFAULTS);
    const out = formatTable(rows);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^Route\s+Baseline\s+Current\s+Delta\s+Status/);
    expect(out).toContain("+10.0 KB (+10.0%)");
    expect(out).toContain("grew");
    expect(lines.find((l) => l.startsWith("/n"))).toContain("—");
  });
});

describe("parseArgs", () => {
  it("valori implicite", () => {
    expect(parseArgs([], {})).toMatchObject({
      update: false,
      json: false,
      distDir: ".next",
      baselinePath: "scripts/perf/bundle-baseline.json",
      tolerancePct: 5,
      toleranceKb: 5,
      capKb: 350,
    });
  });

  it("flag-urile bat env-ul; env-ul bate valorile implicite", () => {
    const env = { NEXT_DIST_DIR: ".next-build", PERF_BUDGET_TOLERANCE_PCT: "8", PERF_BUDGET_CAP_KB: "300" };
    const a = parseArgs(["--json", "--tolerance-pct=3", "--cap-kb", "400"], env);
    expect(a).toMatchObject({ json: true, distDir: ".next-build", tolerancePct: 3, capKb: 400, toleranceKb: 5 });
    expect(parseArgs(["--update", "--dir", "out"], env)).toMatchObject({ update: true, distDir: "out", tolerancePct: 8 });
  });

  it("respinge argumente necunoscute și valori invalide", () => {
    expect(() => parseArgs(["--nope"], {})).toThrow(/necunoscut/);
    expect(() => parseArgs(["--cap-kb", "abc"], {})).toThrow(/invalid/);
    expect(() => parseArgs(["--dir"], {})).toThrow(/Lipsește/);
  });
});

describe("buildBaseline", () => {
  it("sortează rutele și adaugă meta", () => {
    const b = buildBaseline({ "/z": 1, "/a": 2 }, { nextVersion: "15.5.18" });
    expect(Object.keys(b.routes)).toEqual(["/a", "/z"]);
    expect(b.meta).toMatchObject({ unit: "gzip-bytes", metric: "first-load-js", nextVersion: "15.5.18" });
  });
});
