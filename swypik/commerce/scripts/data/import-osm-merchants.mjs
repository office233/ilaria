#!/usr/bin/env node
/**
 * Import restaurante/localuri din OpenStreetMap (Overpass API) ca profiluri
 * "unclaimed" (seller_id NULL) în local_merchants.
 *
 * Acoperă și mediul rural: rulează pe județ întreg (admin_level=4/6) sau pe oraș.
 *
 * Utilizare:
 *   DATABASE_URL=postgres://... node scripts/import-osm-merchants.mjs --city "Focșani"
 *   DATABASE_URL=postgres://... node scripts/import-osm-merchants.mjs --county "Vrancea"
 *   ... [--status pending|active] [--dry-run]
 *
 * Idempotent: ON CONFLICT (osm_type, osm_id) DO UPDATE (doar câmpuri OSM,
 * nu suprascrie profiluri revendicate - skip dacă seller_id IS NOT NULL).
 * Atribuire date: © OpenStreetMap contributors (ODbL).
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

// ---------- argumente ----------
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const city = argVal("--city");
const county = argVal("--county");
const importStatus = argVal("--status") || "active";
const dryRun = args.includes("--dry-run");

if ((!city && !county) || (city && county)) {
  console.error('Utilizare: --city "Focșani" SAU --county "Vrancea" [--status pending|active] [--dry-run]');
  process.exit(1);
}
if (!["pending", "active"].includes(importStatus)) {
  console.error("--status trebuie să fie pending sau active");
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl && !dryRun) {
  console.error("Setează DATABASE_URL în env (sau folosește --dry-run).");
  process.exit(1);
}

// ---------- helpers ----------
function slugify(input) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

/** amenity OSM -> kind local_merchants */
const AMENITIES = ["restaurant", "fast_food", "cafe", "pub", "bar", "ice_cream"];
function kindFor(tags) {
  // toate localurile de mâncare le tratăm ca 'restaurant' (CHECK-ul tabelei)
  return "restaurant";
}

/** cuisine OSM "pizza;kebab" -> text[] normalizat */
// Taxonomia unică (aceeași ca API-ul și chip-urile din /food): lib/merchants/cuisines.json.
const CUISINE_TAXONOMY = JSON.parse(
  readFileSync(new URL("../../lib/merchants/cuisines.json", import.meta.url), "utf8"),
).cuisines;
const CUISINE_MAP = Object.fromEntries(
  CUISINE_TAXONOMY.flatMap((c) => [c.id, ...c.aliases].map((a) => [a.toLowerCase().replace(/\s+/g, "_"), c.id])),
);
function cuisinesFor(tags) {
  const out = new Set();
  const raw = (tags.cuisine || "").toLowerCase();
  for (const c of raw.split(/[;,]/)) {
    const k = c.trim().replace(/\s+/g, "_");
    if (!k) continue;
    out.add(CUISINE_MAP[k] || k.replace(/_/g, " "));
  }
  if (out.size === 0) {
    if (tags.amenity === "fast_food") out.add("fast_food");
    else if (tags.amenity === "cafe") out.add("cafe");
    else if (tags.amenity === "ice_cream") out.add("desserts");
    else out.add("romanian");
  }
  return [...out].slice(0, 5);
}

const DAYS = { Mo: "mon", Tu: "tue", We: "wed", Th: "thu", Fr: "fri", Sa: "sat", Su: "sun" };
const DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
/** Parser best-effort pentru opening_hours OSM simple ("Mo-Fr 09:00-22:00; Sa 10:00-23:00").
 *  Formate exotice -> {} (necunoscut). */
function openingHoursFor(raw) {
  if (!raw) return {};
  if (/24\s*\/\s*7/.test(raw)) {
    const all = {}; for (const d of Object.values(DAYS)) all[d] = [["00:00", "23:59"]];
    return all;
  }
  const out = {};
  try {
    for (const part of raw.split(";")) {
      const m = part.trim().match(/^([A-Za-z,\- ]+)?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) continue;
      const [, daysRaw, from, to] = m;
      let days = [];
      if (!daysRaw || !daysRaw.trim()) days = DAY_ORDER;
      else {
        for (const seg of daysRaw.split(",")) {
          const s = seg.trim();
          const range = s.match(/^([A-Z][a-z])\s*-\s*([A-Z][a-z])$/);
          if (range) {
            const a = DAY_ORDER.indexOf(range[1]), b = DAY_ORDER.indexOf(range[2]);
            if (a !== -1 && b !== -1 && a <= b) days.push(...DAY_ORDER.slice(a, b + 1));
          } else if (DAY_ORDER.includes(s)) days.push(s);
        }
      }
      for (const d of days) {
        const key = DAYS[d];
        if (!key) continue;
        (out[key] ||= []).push([from.padStart(5, "0"), to.padStart(5, "0")]);
      }
    }
  } catch { return {}; }
  return out;
}

function addressFor(tags) {
  const parts = [];
  if (tags["addr:street"]) {
    parts.push(`${tags["addr:street"]}${tags["addr:housenumber"] ? " " + tags["addr:housenumber"] : ""}`);
  }
  const loc = tags["addr:city"] || tags["addr:village"] || tags["addr:hamlet"];
  if (loc) parts.push(loc);
  return parts.join(", ") || null;
}

/** Poza reală a localului, dacă există în OSM (tag `image` sau Wikimedia Commons — licențe libere). */
function imageFor(tags) {
  const img = tags.image || tags["image:0"];
  if (img && /^https?:\/\//.test(img)) return img.split(";")[0].trim();
  const wc = tags.wikimedia_commons;
  if (wc && wc.startsWith("File:")) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(wc.slice(5))}?width=800`;
  }
  return null;
}

/** Reverse-geocoding Nominatim pentru localuri fără addr:city (max 1 req/s — politica lor). */
async function reverseCity(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=13&accept-language=ro`,
      { headers: { "User-Agent": "SwypikFoodImport/1.0 (contact@swypik.com)" } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const a = d.address ?? {};
    return a.city || a.town || a.village || a.municipality || null;
  } catch { return null; }
}

// ---------- Overpass ----------
const amenityRe = AMENITIES.join("|");
/** Coduri ISO 3166-2 pentru județe — interogare mult mai rapidă decât după nume. */
const COUNTY_ISO = {
  alba: "RO-AB", arad: "RO-AR", arges: "RO-AG", bacau: "RO-BC", bihor: "RO-BH",
  "bistrita-nasaud": "RO-BN", botosani: "RO-BT", brasov: "RO-BV", braila: "RO-BR",
  bucuresti: "RO-B", buzau: "RO-BZ", "caras-severin": "RO-CS", calarasi: "RO-CL",
  cluj: "RO-CJ", constanta: "RO-CT", covasna: "RO-CV", dambovita: "RO-DB",
  dolj: "RO-DJ", galati: "RO-GL", giurgiu: "RO-GR", gorj: "RO-GJ",
  harghita: "RO-HR", hunedoara: "RO-HD", ialomita: "RO-IL", iasi: "RO-IS",
  ilfov: "RO-IF", maramures: "RO-MM", mehedinti: "RO-MH", mures: "RO-MS",
  neamt: "RO-NT", olt: "RO-OT", prahova: "RO-PH", "satu mare": "RO-SM",
  salaj: "RO-SJ", sibiu: "RO-SB", suceava: "RO-SV", teleorman: "RO-TR",
  timis: "RO-TM", tulcea: "RO-TL", vaslui: "RO-VS", valcea: "RO-VL", vrancea: "RO-VN",
};
function countyIso(name) {
  const key = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return COUNTY_ISO[key];
}
let areaFilter;
if (city) {
  areaFilter = `area["name"="${city}"]["boundary"="administrative"]["admin_level"~"8|9"]->.a;`;
} else {
  const iso = countyIso(county);
  if (!iso) { console.error(`Județ necunoscut: ${county}`); process.exit(1); }
  areaFilter = `area["ISO3166-2"="${iso}"]->.a;`;
}

const query = `
[out:json][timeout:120];
${areaFilter}
(
  nwr["amenity"~"^(${amenityRe})$"]["name"](area.a);
);
out center tags;
`;

console.log(`Interoghez Overpass pentru ${city ? "orașul " + city : "județul " + county}...`);
const MIRRORS = [
  OVERPASS_URL,
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
async function fetchOverpass() {
  let lastErr = "";
  for (const url of [...new Set(MIRRORS)]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "SwypikFoodImport/1.0 (contact@swypik.com)",
          },
          body: "data=" + encodeURIComponent(query),
        });
        if (res.ok) return res.json();
        lastErr = `${url} -> HTTP ${res.status}`;
        console.warn(`  ${lastErr}, ${attempt < 2 ? "retry în 15s" : "trec la următorul mirror"}...`);
      } catch (e) {
        lastErr = `${url} -> ${e.message}`;
        console.warn(`  ${lastErr}`);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 15000));
    }
  }
  console.error(`Toate mirror-urile Overpass au eșuat. Ultima eroare: ${lastErr}`);
  process.exit(1);
}
const data = await fetchOverpass();
const elements = (data.elements || []).filter((e) => e.tags?.name);
console.log(`Găsite ${elements.length} localuri cu nume în OSM.`);

// ---------- transformare ----------
const rows = elements.map((e) => {
  const t = e.tags;
  const lat = e.lat ?? e.center?.lat ?? null;
  const lng = e.lon ?? e.center?.lon ?? null;
  const locCity =
    t["addr:city"] || t["addr:village"] || t["addr:hamlet"] || (city || null);
  return {
    osm_type: e.type,
    osm_id: e.id,
    name: t.name.trim().slice(0, 120),
    slug: `${slugify(t.name)}-${e.type.charAt(0)}${e.id}`,
    kind: kindFor(t),
    cuisine_types: cuisinesFor(t),
    phone: t.phone || t["contact:phone"] || null,
    email: t.email || t["contact:email"] || null,
    address: addressFor(t),
    location_city: locCity,
    location_lat: lat,
    location_lng: lng,
    opening_hours: openingHoursFor(t.opening_hours),
    description: t.description || null,
    image_url: imageFor(t),
  };
});

// Completează orașul lipsă prin reverse-geocoding (respectăm 1 req/s Nominatim).
const missingCity = rows.filter((r) => !r.location_city && r.location_lat != null);
if (missingCity.length > 0 && !dryRun) {
  console.log(`Reverse-geocoding pentru ${missingCity.length} localuri fără oraș (1/s)...`);
  for (const r of missingCity) {
    r.location_city = await reverseCity(r.location_lat, r.location_lng);
    await new Promise((res) => setTimeout(res, 1100));
  }
}

if (dryRun) {
  for (const r of rows.slice(0, 20)) {
    console.log(`- ${r.name} [${r.cuisine_types.join(",")}] ${r.location_city ?? "?"} (${r.osm_type}/${r.osm_id})`);
  }
  console.log(`\nDRY RUN: ${rows.length} rânduri (afișate primele 20). Nimic scris în DB.`);
  process.exit(0);
}

// ---------- upsert ----------
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
let inserted = 0, updated = 0, skippedClaimed = 0;
try {
  await client.query("BEGIN");
  for (const r of rows) {
    const q = await client.query(
      `INSERT INTO local_merchants
         (kind, name, slug, description, cuisine_types, phone, email, address,
          location_country, location_city, location_lat, location_lng,
         opening_hours, status, source, osm_type, osm_id, image_url, listing_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RO',$9,$10,$11,$12,$13,'osm',$14,$15,$16,'suggest_only')
       ON CONFLICT (osm_type, osm_id) WHERE osm_id IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         cuisine_types = EXCLUDED.cuisine_types,
         phone = COALESCE(local_merchants.phone, EXCLUDED.phone),
         email = COALESCE(local_merchants.email, EXCLUDED.email),
         address = COALESCE(EXCLUDED.address, local_merchants.address),
         location_city = COALESCE(EXCLUDED.location_city, local_merchants.location_city),
         location_lat = EXCLUDED.location_lat,
         location_lng = EXCLUDED.location_lng,
         opening_hours = CASE WHEN local_merchants.opening_hours = '{}'::jsonb
                              THEN EXCLUDED.opening_hours ELSE local_merchants.opening_hours END,
         image_url = CASE WHEN EXCLUDED.image_url IS NOT NULL THEN EXCLUDED.image_url
                          ELSE local_merchants.image_url END,
         updated_at = now()
       WHERE local_merchants.seller_id IS NULL
       RETURNING (xmax = 0) AS is_insert`,
      [
        r.kind, r.name, r.slug, r.description, r.cuisine_types, r.phone, r.email,
        r.address, r.location_city, r.location_lat, r.location_lng,
        JSON.stringify(r.opening_hours), importStatus, r.osm_type, r.osm_id, r.image_url,
      ]
    );
    if (q.rowCount === 0) skippedClaimed++;
    else if (q.rows[0].is_insert) inserted++;
    else updated++;
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Eroare, rollback:", e.message);
  process.exit(1);
} finally {
  await client.end();
}
console.log(`Gata: ${inserted} inserate, ${updated} actualizate, ${skippedClaimed} sărite (revendicate).`);
console.log("Date © OpenStreetMap contributors (ODbL).");
