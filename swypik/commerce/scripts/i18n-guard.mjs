#!/usr/bin/env node
/**
 * GARDIAN i18n — rulează la pre-commit și în CI. Blochează commit-ul dacă:
 *  1. Vreun messages/*.json e JSON invalid (coruperea din 2026-08-02!)
 *  2. Există chei în ro.json care lipsesc în alte limbi
 *  3. Există stringuri hardcodate românești în cod nou (via scan-hardcoded)
 *
 * Cu --fix: încearcă întâi traducerea automată (translate-messages.mjs)
 * pentru cheile lipsă, apoi re-verifică.
 *
 * Usage:
 *   node scripts/i18n-guard.mjs          # doar verifică (pre-commit / CI)
 *   node scripts/i18n-guard.mjs --fix    # traduce automat ce lipsește, apoi verifică
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const LOCALES = ["ro", "en", "es", "fr", "de", "pt", "it"];
const fix = process.argv.includes("--fix");
let failed = false;
const err = (m) => { console.error("✗ " + m); failed = true; };
const ok = (m) => console.log("✓ " + m);

// ── 1. JSON valid ─────────────────────────────────────────────
const data = {};
for (const l of LOCALES) {
    try {
        data[l] = JSON.parse(fs.readFileSync(`messages/${l}.json`, "utf8"));
    } catch (e) {
        err(`messages/${l}.json JSON INVALID: ${e.message}`);
    }
}
if (failed) {
    console.error("\nJSON corupt — commit blocat. Repară fișierele de mai sus.");
    process.exit(1);
}
ok(`JSON valid: ${LOCALES.length} locale`);

// ── 2. Chei lipsă vs ro ───────────────────────────────────────
const flat = (o, p = "") => {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flat(v, key));
        else out[key] = v;
    }
    return out;
};
const M = Object.fromEntries(LOCALES.map((l) => [l, flat(data[l])]));
const roKeys = Object.keys(M.ro);

const missing = {};
for (const l of LOCALES.filter((x) => x !== "ro")) {
    const miss = roKeys.filter((k) => !(k in M[l]) || M[l][k] == null || M[l][k] === "");
    if (miss.length) missing[l] = miss;
}

if (Object.keys(missing).length && fix) {
    console.log("\n→ Chei lipsă detectate, rulez traducerea automată…");
    try {
        execSync("node scripts/translate-messages.mjs", { stdio: "inherit" });
    } catch {
        err("translate-messages.mjs a eșuat (verifică STUDIAI_API_KEY)");
    }
    // re-verifică
    for (const l of Object.keys(missing)) {
        const j = flat(JSON.parse(fs.readFileSync(`messages/${l}.json`, "utf8")));
        missing[l] = roKeys.filter((k) => !(k in j) || j[k] == null || j[k] === "");
        if (!missing[l].length) delete missing[l];
    }
}

for (const [l, miss] of Object.entries(missing)) {
    err(`${l}: ${miss.length} chei lipsă/goale — ex: ${miss.slice(0, 5).join(", ")}`);
}
if (!Object.keys(missing).length) ok(`chei complete: ${roKeys.length} chei × ${LOCALES.length - 1} limbi`);

// ── 3. Hardcodări în cod ──────────────────────────────────────
// Baseline: hardcodările istorice (majoritatea în backoffice) sunt tolerate;
// blocăm doar CREȘTEREA numărului (cod nou netradus). Baseline în .i18n-baseline.json.
//
// `scan-hardcoded.mjs` a fost șters în commitul 80b08aae ("107 scripturi
// one-off consumate"), dar apelul de aici a rămas. Rezultatul: gardianul
// trecea verificările 1 și 2, apoi murea cu MODULE_NOT_FOUND și ieșea cu 1 —
// deci ORICE commit pe `messages/`, `app/` sau `components/` ar fi fost
// blocat, indiferent cât de corecte erau traducerile. Nu s-a observat fiindcă
// hook-ul era dezactivat local (`core.hooksPath=/dev/null`).
//
// Acum verificarea lipsă e semnalată, nu fatală: mai bine două verificări
// care chiar rulează decât trei dintre care una omoară tot.
const SCANNER = "scripts/scan-hardcoded.mjs";
if (!fs.existsSync(SCANNER)) {
    console.log(`⚠ ${SCANNER} lipsește — verificarea de hardcodări e SĂRITĂ.`);
    console.log("  Cheile lipsă și JSON-ul stricat se verifică în continuare.");
} else try {
    const out = execSync("node scripts/scan-hardcoded.mjs", { encoding: "utf8" });
    const m = out.match(/files:\s*(\d+)\s*hits:\s*(\d+)/);
    const hits = m ? +m[2] : 0;
    let baseline = 0;
    try { baseline = JSON.parse(fs.readFileSync(".i18n-baseline.json", "utf8")).hits; } catch { }
    if (hits > baseline) {
        err(`scan-hardcoded: ${hits} hardcodări (baseline ${baseline}) — ai adăugat ${hits - baseline} stringuri netraduse noi`);
        console.error(out.split("\n").slice(0, 15).join("\n"));
    } else {
        ok(`hardcodări: ${hits} ≤ baseline ${baseline}`);
        if (hits < baseline) {
            fs.writeFileSync(".i18n-baseline.json", JSON.stringify({ hits }) + "\n");
            console.log(`  (baseline actualizat: ${baseline} → ${hits})`);
        }
    }
} catch (e) {
    err("scan-hardcoded.mjs a eșuat: " + e.message.slice(0, 100));
}

// ── Verdict ───────────────────────────────────────────────────
if (failed) {
    console.error(`\n✗ i18n-guard: COMMIT BLOCAT.${fix ? "" : " Rulează cu --fix pentru traducere automată:"}`);
    if (!fix) console.error("    node scripts/i18n-guard.mjs --fix");
    process.exit(1);
}
console.log("\n✓ i18n-guard: totul tradus și valid.");
