#!/usr/bin/env node
/**
 * Buget de bundle: First-Load JS (gzip) per rută, comparat cu un baseline commis.
 *
 * Rulează DUPĂ `next build` (în `npm run ci` imediat după build):
 *   npm run perf:budget                      # compară cu scripts/perf/bundle-baseline.json
 *   npm run perf:budget -- --update          # rescrie baseline-ul (după o creștere asumată)
 *   npm run perf:budget -- --json            # ieșire JSON pentru mașini
 *   npm run perf:budget -- --dir .next-build # alt NEXT_DIST_DIR
 *
 * Calcul: pentru fiecare pagină din `.next/app-build-manifest.json` (App Router)
 * și `.next/build-manifest.json` (Pages Router), fișierele JS = rootMainFiles +
 * chunk-urile intrării; dimensiunea = gzip (zlib, nivel 9) al fiecărui fișier din
 * `<distDir>/`. Chunk-urile partajate se numără la fiecare rută. Polyfill-urile
 * (nomodule) nu se numără. Logica pură: scripts/perf/budget-lib.mjs.
 *
 * Eșec (exit 1) dacă:
 *   - o rută existentă crește cu mai mult de max(+TOLERANȚĂ%, +TOLERANȚĂ KB)
 *     (implicit max(+5%, +5 KB); --tolerance-pct / --tolerance-kb sau
 *     PERF_BUDGET_TOLERANCE_PCT / PERF_BUDGET_TOLERANCE_KB);
 *   - o rută nouă depășește plafonul absolut (implicit 350 KB gzip;
 *     --cap-kb / PERF_BUDGET_CAP_KB).
 * Exit 2 = eroare de rulare (build lipsă, manifest invalid, argumente greșite).
 *
 * Baseline lipsă → mesaj explicit și exit 0 (primul rulaj: `next build` apoi
 * `npm run perf:budget -- --update` și commit la scripts/perf/bundle-baseline.json).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  buildBaseline,
  collectRouteFiles,
  compareToBaseline,
  computeFirstLoad,
  formatKb,
  formatTable,
  parseArgs,
} from "./budget-lib.mjs";

const HELP = `Utilizare: node scripts/perf/budget.mjs [--update] [--json] [--dir <distDir>]
  [--baseline <fișier>] [--tolerance-pct <n>] [--tolerance-kb <n>] [--cap-kb <n>]`;

function readJson(path, required) {
  if (!existsSync(path)) {
    if (required) throw new Error(`Lipsește ${path} — rulează întâi \`next build\`.`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function makeSizeOf(distDir) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const path = join(distDir, file);
    const size = existsSync(path) ? gzipSync(readFileSync(path), { level: 9 }).length : null;
    cache.set(file, size);
    return size;
  };
}

function nextVersion() {
  try {
    return JSON.parse(readFileSync(resolve("node_modules/next/package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const distDir = resolve(args.distDir);
  const buildManifest = readJson(join(distDir, "build-manifest.json"), true);
  const appBuildManifest = readJson(join(distDir, "app-build-manifest.json"), false);

  const routeFiles = collectRouteFiles({ appBuildManifest, buildManifest });
  if (routeFiles.size === 0) throw new Error(`Nicio rută în manifestele din ${distDir}.`);
  const { sizes, missing } = computeFirstLoad(routeFiles, makeSizeOf(distDir));
  if (missing.length) {
    console.warn(`Atenție: ${missing.length} fișiere din manifest lipsesc din ${distDir} (numărate 0): ${missing.slice(0, 5).join(", ")}`);
  }

  const baselinePath = resolve(args.baselinePath);
  if (args.update) {
    const baseline = buildBaseline(sizes, {
      generatedAt: new Date().toISOString(),
      nextVersion: nextVersion(),
      routes: Object.keys(sizes).length,
      note: "First-Load JS gzip per rută; regenerează cu `npm run perf:budget -- --update` după `next build`.",
    });
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Baseline scris: ${baselinePath} (${Object.keys(sizes).length} rute).`);
    return 0;
  }

  const baseline = readJson(baselinePath, false);
  if (!baseline || !baseline.routes) {
    console.log(
      `Baseline lipsă (${args.baselinePath}) — bugetul nu e verificat.\n` +
        "Generează-l după `next build` cu `npm run perf:budget -- --update` și commite fișierul.",
    );
    return 0;
  }

  const opts = { tolerancePct: args.tolerancePct, toleranceKb: args.toleranceKb, capKb: args.capKb };
  const result = compareToBaseline(sizes, baseline.routes, opts);
  if (args.json) {
    console.log(JSON.stringify({ ok: result.ok, options: opts, distDir, missing, rows: result.rows }, null, 2));
  } else {
    console.log(formatTable(result.rows));
    const largest = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0];
    console.log(`\n${Object.keys(sizes).length} rute; cea mai mare: ${largest[0]} (${formatKb(largest[1])}).`);
    console.log(`Toleranță: max(+${opts.tolerancePct}%, +${opts.toleranceKb} KB); plafon rute noi: ${opts.capKb} KB gzip.`);
    if (result.ok) console.log("Buget OK.");
    else {
      console.error(`\nBuget DEPĂȘIT pe ${result.failures.length} rute:`);
      for (const f of result.failures) console.error(`  ${f.route}: ${formatKb(f.current)} (${f.status})`);
      console.error("Dacă creșterea e asumată: `npm run perf:budget -- --update` și commite baseline-ul.");
    }
  }
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`perf:budget: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
