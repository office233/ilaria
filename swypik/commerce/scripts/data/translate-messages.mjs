#!/usr/bin/env node
/**
 * Traduce messages/ro.json -> messages/{en,es,fr,de,pt,it}.json folosind StudiAI.
 *
 * Strategie:
 *  - Citește RO ca sursă unică.
 *  - Pentru fiecare limbă țintă, păstrează cheile deja traduse (nu rescrie).
 *  - Trimite în batch toate cheile lipsă/nule la modelul Claude prin StudiAI.
 *  - Prezervă structura ierarhică (nested keys).
 *  - Idempotent: rulat de două ori NU schimbă nimic dacă nu s-au adăugat chei noi.
 *
 * Usage:
 *   node scripts/translate-messages.mjs                 # toate limbile
 *   node scripts/translate-messages.mjs --locale=en     # doar EN
 *   node scripts/translate-messages.mjs --force         # rescrie tot (default: doar lipsă)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MESSAGES_DIR = join(ROOT, "messages");

const TARGET_LOCALES = ["en", "es", "fr", "de", "pt", "it"];
const LANG_NAMES = {
  en: "English",
  es: "Spanish (Spain)",
  fr: "French (France)",
  de: "German (Germany)",
  pt: "Portuguese (Portugal)",
  it: "Italian (Italy)",
};

const args = new Set(process.argv.slice(2));
const onlyLocale = [...args].find((a) => a.startsWith("--locale="))?.split("=")[1];
const force = args.has("--force");

const API_KEY = process.env.STUDIAI_API_KEY;
const BASE_URL = process.env.STUDIAI_BASE_URL || "https://ai.studiai.ro/v1";
const API_URL = `${BASE_URL}/chat/completions`;
const MODEL = process.env.STUDIAI_MODEL || "claude-haiku-4-5";

if (!API_KEY) {
  console.error("ERROR: STUDIAI_API_KEY not set");
  process.exit(1);
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function unflatten(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = v;
  }
  return out;
}

async function translateBatch(roEntries, targetLocale) {
  const lang = LANG_NAMES[targetLocale];
  const prompt = `You translate UI microcopy from Romanian to ${lang} for a mobile-first video-commerce app called "Swypik".

Rules:
- Keep it SHORT and natural for native ${lang} speakers (no literal translations).
- Preserve placeholders like {email}, {count}, {price} EXACTLY.
- Preserve brand names: Swypik, Google, Apple, Stripe, GDPR.
- Match the tone: friendly, direct, mobile UI.
- Return ONLY a JSON object mapping each key to its translation. No prose, no markdown fences.

Input (Romanian):
${JSON.stringify(roEntries, null, 2)}

Output JSON (${lang} translations, same keys):`;

  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 8000,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || "";
  // Strip eventual code fences
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Cannot parse model output: ${cleaned.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

async function processLocale(locale, roFlat) {
  const file = join(MESSAGES_DIR, `${locale}.json`);
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    /* file may not exist */
  }
  const existingFlat = flatten(existing);

  const missing = {};
  for (const [k, v] of Object.entries(roFlat)) {
    if (force || existingFlat[k] === undefined || existingFlat[k] === null || existingFlat[k] === "") {
      missing[k] = v;
    }
  }

  const total = Object.keys(roFlat).length;
  const missingCount = Object.keys(missing).length;
  if (missingCount === 0) {
    console.log(`[${locale}] already complete (${total} keys)`);
    return;
  }
  console.log(`[${locale}] translating ${missingCount}/${total} missing keys...`);

  // Chunk to keep response JSON under ~7K tokens
  const CHUNK = (locale === 'de' || locale === 'fr') ? 1 : 60;
  const entries = Object.entries(missing);
  let translated = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
    const chunkNum = Math.floor(i / CHUNK) + 1;
    const totalChunks = Math.ceil(entries.length / CHUNK);
    let attempt = 0;
    let success = false;
    while (attempt < 3 && !success) {
      attempt++;
      try {
        const part = await translateBatch(chunk, locale);
        Object.assign(translated, part);
        console.log(`  [${locale}] chunk ${chunkNum}/${totalChunks} ok (${Object.keys(part).length}/${Object.keys(chunk).length})`);
        success = true;
      } catch (e) {
        console.warn(`  [${locale}] chunk ${chunkNum}/${totalChunks} attempt ${attempt} failed: ${e.message.slice(0, 100)}`);
        if (attempt >= 3) {
          console.warn(`  [${locale}] giving up on chunk ${chunkNum}, will use RO fallback for ${Object.keys(chunk).length} keys`);
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  const merged = { ...existingFlat, ...translated };
  // Asigură că toate cheile RO sunt prezente (chiar dacă modelul a omis ceva)
  for (const k of Object.keys(roFlat)) {
    if (!merged[k]) {
      console.warn(`  [${locale}] model omitted key ${k}, falling back to RO`);
      merged[k] = roFlat[k];
    }
  }
  // Elimină chei orfane (care există în target dar NU în RO sursă)
  const sanitized = {};
  for (const k of Object.keys(roFlat)) sanitized[k] = merged[k];

  const nested = unflatten(sanitized);
  writeFileSync(file, JSON.stringify(nested, null, 2) + "\n");
  console.log(`[${locale}] wrote ${Object.keys(sanitized).length} keys to ${file}`);
}

async function main() {
  const roPath = join(MESSAGES_DIR, "ro.json");
  const ro = JSON.parse(readFileSync(roPath, "utf-8"));
  const roFlat = flatten(ro);
  console.log(`Source: ${Object.keys(roFlat).length} keys in ro.json`);

  const targets = onlyLocale ? [onlyLocale] : TARGET_LOCALES;
  for (const locale of targets) {
    try {
      await processLocale(locale, roFlat);
    } catch (e) {
      console.error(`[${locale}] FAILED: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
