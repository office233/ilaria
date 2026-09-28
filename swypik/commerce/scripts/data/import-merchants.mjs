#!/usr/bin/env node
/**
 * Import comercianți locali (restaurante) dintr-un CSV direct în Postgres.
 *
 * CSV: nume,adresa,oras,telefon,email  (cu header, virgulă ca separator)
 * Rândurile importate primesc status='active' (vizibile imediat în Food).
 *
 * Utilizare:
 *   DATABASE_URL=postgres://... node scripts/import-merchants.mjs scripts/merchants-sample.csv
 */
import fs from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("Utilizare: node scripts/import-merchants.mjs <fisier.csv>");
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Setează DATABASE_URL în env.");
  process.exit(1);
}

function slugify(input) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

/** Parser CSV simplu cu suport pentru câmpuri între ghilimele. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

const text = fs.readFileSync(file, "utf8");
const rows = parseCsv(text);
if (rows.length < 2) {
  console.error("CSV gol sau doar header.");
  process.exit(1);
}
const header = rows[0].map((h) => h.trim().toLowerCase());
const idx = (name) => header.indexOf(name);
for (const col of ["nume", "adresa", "oras", "telefon"]) {
  if (idx(col) === -1) {
    console.error(`Lipsește coloana obligatorie '${col}'. Header: ${header.join(",")}`);
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let ok = 0, skipped = 0;
try {
  for (const r of rows.slice(1)) {
    const name = (r[idx("nume")] ?? "").trim();
    const address = (r[idx("adresa")] ?? "").trim();
    const city = (r[idx("oras")] ?? "").trim();
    const phone = (r[idx("telefon")] ?? "").trim();
    const email = idx("email") !== -1 ? (r[idx("email")] ?? "").trim() || null : null;
    if (!name || !address || !city || !phone) {
      console.warn(`skip rând incomplet: ${JSON.stringify(r)}`);
      skipped++;
      continue;
    }
    const slug = `${slugify(name)}-${slugify(city)}`;
    const res = await client.query(
      `INSERT INTO local_merchants (kind, name, slug, phone, email, address, location_country, location_city, status)
       VALUES ('restaurant', $1, $2, $3, $4, $5, 'RO', $6, 'active')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [name, slug, phone, email, address, city],
    );
    if (res.rowCount === 0) {
      console.warn(`skip duplicat (slug ${slug}): ${name}`);
      skipped++;
    } else {
      console.log(`+ ${name} (${city}) → ${res.rows[0].id}`);
      ok++;
    }
  }
} finally {
  await client.end();
}
console.log(`\nImport terminat: ${ok} inserate, ${skipped} sărite.`);
