#!/usr/bin/env node
/**
 * scan-design-debt — gardian pentru design system (rulează în CI și `npm run lint:design`).
 *
 * Numără în app/ și components/ (.ts, .tsx, .css):
 *   - hex:       culori hex literale (#7C3AED, #fff…) — culorile trebuie să vină din
 *                tokenuri (app/styles/tokens.css → clase Tailwind bg-surface, text-muted…)
 *   - smallText: text sub 12px (`text-[10px]`, `text-[11px]`…)
 *
 * Datoria istorică e tolerată: eșuează DOAR dacă un număr CREȘTE față de
 * `.design-baseline.json`. După ce reduci datoria, rulează cu `--update` ca să
 * cobori baseline-ul (nu îl urca niciodată ca să treacă un PR).
 *
 * Usage:
 *   node scripts/scan-design-debt.mjs            # verifică (exit 1 la creștere)
 *   node scripts/scan-design-debt.mjs --update   # rescrie baseline-ul cu valorile curente
 *   node scripts/scan-design-debt.mjs --report   # top fișiere cu datorie
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["app", "components"];
const EXT = new Set([".ts", ".tsx", ".css"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "__tests__"]);
// Singurul loc unde culorile au voie să fie definite (canale RGB, nu hex, dar îl excludem explicit).
const IGNORE_FILES = new Set(["app/styles/tokens.css"]);
const BASELINE_FILE = ".design-baseline.json";

export const HEX_RE = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
export const SMALL_TEXT_RE = /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g;

export function countMatches(source, re) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(source)) n++;
  return n;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(entry.name))) out.push(full);
  }
}

export function scan(roots = ROOTS) {
  const files = [];
  for (const root of roots) if (fs.existsSync(root)) walk(root, files);
  const totals = { hex: 0, smallText: 0 };
  const perFile = [];
  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    if (IGNORE_FILES.has(rel)) continue;
    const src = fs.readFileSync(file, "utf8");
    const hex = countMatches(src, HEX_RE);
    const smallText = countMatches(src, SMALL_TEXT_RE);
    totals.hex += hex;
    totals.smallText += smallText;
    if (hex || smallText) perFile.push({ file: rel, hex, smallText });
  }
  return { files: files.length, totals, perFile };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { files, totals, perFile } = scan();
  console.log(`files: ${files} hex: ${totals.hex} smallText: ${totals.smallText}`);

  if (args.has("--report")) {
    for (const row of perFile.sort((a, b) => b.hex + b.smallText - (a.hex + a.smallText)).slice(0, 40)) {
      console.log(`  ${String(row.hex).padStart(4)} hex ${String(row.smallText).padStart(3)} <12px  ${row.file}`);
    }
  }

  if (args.has("--update")) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(totals, null, 2) + "\n");
    console.log(`✓ baseline actualizat în ${BASELINE_FILE}`);
    return;
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`✗ lipsește ${BASELINE_FILE} — rulează cu --update o dată`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  let failed = false;
  for (const key of Object.keys(totals)) {
    const base = Number(baseline[key] ?? 0);
    if (totals[key] > base) {
      console.error(
        `✗ ${key}: ${totals[key]} > baseline ${base}. Folosește tokenurile din app/styles/tokens.css ` +
          `(bg-surface, text-muted, border-subtle, bg-brand…) și text de minim 12px (text-xs).`,
      );
      failed = true;
    } else if (totals[key] < base) {
      console.log(`✓ ${key}: ${totals[key]} (sub baseline ${base} — rulează --update ca să-l cobori)`);
    } else {
      console.log(`✓ ${key}: ${totals[key]} (= baseline)`);
    }
  }
  if (failed) process.exit(1);
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
