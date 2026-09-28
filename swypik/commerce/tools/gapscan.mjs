/**
 * Scanează golurile dintre catalogul de verticale, API-uri și paginile UI.
 * Rulare: node tools/gapscan.mjs
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const has = (p) => existsSync(join(ROOT, p));

const catalog = readFileSync(join(ROOT, "lib/verticals/catalog.ts"), "utf8");
const verticals = [...catalog.matchAll(/id:\s*"([\w-]+)",\s*brand:\s*"([^"]+)"[\s\S]{0,400}?mode:\s*"(\w+)"/g)]
    .map((m) => ({ id: m[1], brand: m[2], mode: m[3] }));

// pagini dedicate cunoscute
const DEDICATED = { eats: "food" };

console.log("=== VERTICALE: are pagină proprie de flux? ===");
const byMode = {};
for (const v of verticals) {
    const dir = DEDICATED[v.id] ?? v.id;
    const page = has(`app/[locale]/${dir}/page.tsx`);
    (byMode[v.mode] ??= []).push({ ...v, page });
}
for (const [mode, list] of Object.entries(byMode)) {
    const withPage = list.filter((x) => x.page).length;
    console.log(`\n  mod "${mode}" — ${withPage}/${list.length} au pagină`);
    list.forEach((x) => console.log(`    ${x.page ? "✅" : "❌"} ${x.brand} (/v/${x.id})`));
}

console.log("\n\n=== PANOURI DE ADMINISTRARE ===");
const panels = [
    ["seller — produse", "app/(site)/seller/products"],
    ["seller — comenzi", "app/(site)/seller/orders"],
    ["seller — anunțuri", "app/(site)/seller/listings"],
    ["seller — restaurant/meniu", "app/(site)/seller/merchant"],
    ["seller — cazări", "app/(site)/seller/stays"],
    ["curier — PWA", "app/[locale]/courier"],
    ["cauză — campanii", "app/[locale]/cares/manage"],
    ["admin — merchants", "app/(site)/admin/merchants"],
    ["admin — curieri", "app/(site)/admin/couriers"],
    ["admin — donații", "app/(site)/admin/donations"],
];
for (const [name, p] of panels) console.log(`  ${has(p) ? "✅" : "❌"} ${name}`);

console.log("\n=== API-uri lipsă pentru fluxuri complete ===");
const apis = [
    ["comenzi merchant (listare)", "app/api/merchants/[id]/orders/route.ts"],
    ["disponibilitate cazare (setare)", "app/api/stays/availability/route.ts"],
    ["campanii — creare/editare", "app/api/campaigns/manage/route.ts"],
    ["cauze — înregistrare", "app/api/causes/route.ts"],
    ["upload media (seller)", "app/api/upload/route.ts"],
    ["webhook plăți", "app/api/webhooks/stripe/route.ts"],
];
for (const [name, p] of apis) console.log(`  ${has(p) ? "✅" : "❌"} ${name}`);
