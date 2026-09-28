/**
 * Logica pură a bugetului de bundle (fără fs / zlib): colectarea fișierelor
 * per rută din manifestele Next, suma First-Load JS, comparația cu baseline-ul
 * și formatarea. Folosită de scripts/perf/budget.mjs, testată în
 * tests/unit/perf-budget.test.ts. Tipuri: budget-lib.d.mts.
 */

export const DEFAULTS = Object.freeze({
  tolerancePct: 5,
  toleranceKb: 5,
  capKb: 350,
});

const KB = 1024;

/**
 * "/[locale]/product/[id]/page" → "/[locale]/product/[id]"; grupurile de rute
 * "(shop)" dispar, ca în tabelul `next build`. Întoarce null pentru intrări
 * care nu sunt pagini (layout, route handlers, template, ...).
 */
export function normalizeAppRoute(entry) {
  if (typeof entry !== "string" || !/(^|\/)page$/.test(entry)) return null;
  const segments = entry
    .replace(/\/?page$/, "")
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s));
  return "/" + segments.join("/");
}

const PAGES_INTERNAL = new Set(["/_app", "/_document", "/_error"]);

function isJs(file) {
  return typeof file === "string" && file.endsWith(".js");
}

function uniqueJs(files) {
  return [...new Set(files.filter(isJs))];
}

/**
 * Fișierele JS încărcate la prima vizită, per rută.
 * - App Router: `buildManifest.rootMainFiles` ∪ `appBuildManifest.pages[<rută>/page]`
 *   (intrarea de pagină include deja chunk-urile layout-urilor părinte).
 * - Pages Router: `pages["/_app"]` ∪ `pages[<rută>]`.
 * Polyfill-urile (`nomodule`) nu intră — browserele moderne nu le descarcă
 * (aceeași convenție ca `next build`).
 * Rutele care coincid după normalizare păstrează reuniunea fișierelor.
 */
export function collectRouteFiles({ appBuildManifest, buildManifest }) {
  const routes = new Map();
  const add = (route, files) => {
    const prev = routes.get(route) || [];
    routes.set(route, uniqueJs([...prev, ...files]));
  };

  const rootMain = (buildManifest && buildManifest.rootMainFiles) || [];
  const appPages = (appBuildManifest && appBuildManifest.pages) || {};
  for (const [entry, files] of Object.entries(appPages)) {
    const route = normalizeAppRoute(entry);
    if (route === null) continue;
    add(route, [...rootMain, ...(files || [])]);
  }

  const pages = (buildManifest && buildManifest.pages) || {};
  const appShell = pages["/_app"] || [];
  for (const [route, files] of Object.entries(pages)) {
    if (PAGES_INTERNAL.has(route)) continue;
    add(route, [...appShell, ...(files || [])]);
  }
  return routes;
}

/**
 * First-Load JS per rută: suma dimensiunilor (gzip) ale fișierelor rutei.
 * Chunk-urile partajate sunt numărate la fiecare rută care le încarcă.
 * `sizeOf(file)` întoarce bytes sau null pentru fișiere lipsă.
 */
export function computeFirstLoad(routeFiles, sizeOf) {
  const sizes = {};
  const missing = new Set();
  for (const [route, files] of routeFiles) {
    let total = 0;
    for (const file of files) {
      const size = sizeOf(file);
      if (size === null || size === undefined) missing.add(file);
      else total += size;
    }
    sizes[route] = total;
  }
  return { sizes, missing: [...missing].sort() };
}

/** Creșterea permisă peste baseline: max(pct% din baseline, kb KB). */
export function allowedGrowth(baselineBytes, { tolerancePct, toleranceKb }) {
  return Math.max(Math.round((baselineBytes * tolerancePct) / 100), Math.round(toleranceKb * KB));
}

/**
 * Compară dimensiunile curente cu baseline-ul.
 * status: ok | grew (peste toleranță → eșec) | new | new-over-cap (eșec) | removed.
 */
export function compareToBaseline(current, baselineRoutes, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const capBytes = Math.round(o.capKb * KB);
  const rows = [];
  for (const route of Object.keys(current)) {
    const cur = current[route];
    const base = Object.prototype.hasOwnProperty.call(baselineRoutes, route) ? baselineRoutes[route] : null;
    if (base === null) {
      rows.push({ route, baseline: null, current: cur, delta: null, status: cur > capBytes ? "new-over-cap" : "new" });
      continue;
    }
    const delta = cur - base;
    rows.push({ route, baseline: base, current: cur, delta, status: delta > allowedGrowth(base, o) ? "grew" : "ok" });
  }
  for (const route of Object.keys(baselineRoutes)) {
    if (!Object.prototype.hasOwnProperty.call(current, route)) {
      rows.push({ route, baseline: baselineRoutes[route], current: null, delta: null, status: "removed" });
    }
  }
  rows.sort((a, b) => (b.delta ?? b.current ?? 0) - (a.delta ?? a.current ?? 0) || a.route.localeCompare(b.route));
  const failures = rows.filter((r) => r.status === "grew" || r.status === "new-over-cap");
  return { rows, failures, ok: failures.length === 0 };
}

export function formatKb(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  return `${(bytes / KB).toFixed(1)} KB`;
}

function formatDelta(row) {
  if (row.delta === null) return "—";
  const sign = row.delta > 0 ? "+" : row.delta < 0 ? "-" : "±";
  const pct = row.baseline ? ` (${sign}${Math.abs((row.delta / row.baseline) * 100).toFixed(1)}%)` : "";
  return `${sign}${(Math.abs(row.delta) / KB).toFixed(1)} KB${pct}`;
}

/** Tabel text aliniat: rută, baseline, curent, delta, status. */
export function formatTable(rows) {
  const header = ["Route", "Baseline", "Current", "Delta", "Status"];
  const body = rows.map((r) => [r.route, formatKb(r.baseline), formatKb(r.current), formatDelta(r), r.status]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cols) => cols[i].length)));
  const line = (cols) => cols.map((c, i) => (i === 0 || i === 4 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)]
    .map((l) => l.trimEnd())
    .join("\n");
}

function numberOr(value, fallback, flag) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Valoare invalidă pentru ${flag}: "${value}"`);
  return n;
}

/**
 * Argumente CLI + env. Flag-urile au prioritate față de env.
 *   --update  --json  --dir <distDir>  --baseline <fișier>
 *   --tolerance-pct <n>  --tolerance-kb <n>  --cap-kb <n>
 * Env: NEXT_DIST_DIR, PERF_BUDGET_TOLERANCE_PCT, PERF_BUDGET_TOLERANCE_KB, PERF_BUDGET_CAP_KB.
 */
export function parseArgs(argv, env) {
  const e = env || {};
  const flags = {};
  const valued = new Set(["--dir", "--baseline", "--tolerance-pct", "--tolerance-kb", "--cap-kb"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === "--update" || name === "--json" || name === "--help") {
      flags[name] = true;
    } else if (valued.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (value === undefined) throw new Error(`Lipsește valoarea pentru ${name}`);
      flags[name] = value;
    } else {
      throw new Error(`Argument necunoscut: ${arg}`);
    }
  }
  return {
    update: Boolean(flags["--update"]),
    json: Boolean(flags["--json"]),
    help: Boolean(flags["--help"]),
    distDir: flags["--dir"] || e.NEXT_DIST_DIR || ".next",
    baselinePath: flags["--baseline"] || "scripts/perf/bundle-baseline.json",
    tolerancePct: numberOr(flags["--tolerance-pct"] ?? e.PERF_BUDGET_TOLERANCE_PCT, DEFAULTS.tolerancePct, "--tolerance-pct"),
    toleranceKb: numberOr(flags["--tolerance-kb"] ?? e.PERF_BUDGET_TOLERANCE_KB, DEFAULTS.toleranceKb, "--tolerance-kb"),
    capKb: numberOr(flags["--cap-kb"] ?? e.PERF_BUDGET_CAP_KB, DEFAULTS.capKb, "--cap-kb"),
  };
}

/** Conținutul fișierului de baseline (rute sortate, pentru diff-uri stabile). */
export function buildBaseline(sizes, meta) {
  const routes = {};
  for (const route of Object.keys(sizes).sort()) routes[route] = sizes[route];
  return { meta: { unit: "gzip-bytes", metric: "first-load-js", ...(meta || {}) }, routes };
}
