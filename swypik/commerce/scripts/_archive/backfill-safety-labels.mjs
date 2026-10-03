#!/usr/bin/env node
/**
 * Backfill product_safety_labels for all marketplace_products.
 * Self-contained: classifier embedded so no TS build required.
 *
 * Usage:  node scripts/backfill-safety-labels.mjs [--dry-run] [--batch=500] [--limit=N]
 */

import pg from "pg";
const { Pool } = pg;

// ===== Classifier v2 (mirror of lib/moderation/classifier.ts) =====

const BLOCKED_KEYWORDS = [
  "child porn", "child sex", "kid sex", "minor sex", "underage sex",
  "lolita sex", "lolita porn", "loli porn", "shota porn",
  "preteen sex", "preteen porn", "pre-teen sex",
  "schoolgirl porn", "kiddie porn", "jailbait",
  "rape video", "revenge porn", "leaked nude", "hidden cam sex",
  "spycam sex", "upskirt video",
  "switchblade knife", "ballistic knife", "gun silencer",
  "ghost gun kit", "plastic explosive", "c4 explosive",
  "live grenade", "frag grenade",
  "cocaine", "heroin", "fentanyl", "meth pipe", "crack pipe", "crystal meth",
  "fake id card", "counterfeit money", "fake passport", "counterfeit currency",
];

const ADULT_KEYWORDS = [
  "18\\+", "xxx", "nsfw", "porn", "pornographic", "pornhub", "onlyfans",
  "sex toy", "sex toys", "sex doll", "sex products", "sex shop",
  "vibrator", "vibrators", "dildo", "dildos",
  "masturbator", "masturbation", "fleshlight",
  "bondage", "bdsm", "fetish gear",
  "butt plug", "anal plug", "anal beads", "anal toy",
  "cock ring", "penis ring", "penis pump", "penis sleeve",
  "vibrating egg", "love egg",
  "g-spot", "g spot",
  "personal lubricant", "sex lubricant", "lube sex",
  "adult only", "adult-only", "adults only",
  "erotic", "erotica", "kinky",
  "crotchless", "pheromone",
  "nipple clamp", "nipple pasties",
  "naked", "nude photo", "nude pic",
  "порно", "секс игрушк", "секс-игрушк", "вибратор", "фаллоимитатор",
  "мастурбатор", "интим товар", "анальн", "эротик",
  "情趣", "成人用品", "性玩具", "震动棒", "av女优",
  "アダルト", "セックス", "オナホ", "バイブ",
  "produse adulti", "produse pentru adulti", "jucarii sexuale", "lubrifiant intim",
];

const SENSITIVE_KEYWORDS = [
  "sexy", "seductive", "sensual", "intimate wear", "lingerie set",
  "thong", "g-string", "fishnet", "babydoll",
  "garter belt", "suspender belt", "bustier", "corset lingerie",
  "see through", "see-through", "sheer lace", "transparent lingerie",
  "open bra", "open cup", "open crotch", "peek a boo",
  "bikini micro", "micro bikini", "sling bikini",
  "boudoir", "pin up", "pinup",
  "bulge", "sissy", "lolita dress",
  "сексуальн", "соблазнительн", "эротичн", "интимн", "пеньюар", "стринги",
  "lenjerie intima", "lenjerie sexy", "lenjerie erotica",
];

const OBFUSCATION_PATTERNS = [
  { name: "s3x", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x([^a-z0-9]|$)/i, label: "adult" },
  { name: "sxy", re: /(^|[^a-z0-9])s[\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "s3xy", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "p0rn", re: /(^|[^a-z0-9])p[\W_]*[0o][\W_]*r[\W_]*n([^a-z0-9]|$)/i, label: "adult" },
  { name: "n4de", re: /(^|[^a-z0-9])n[\W_]*[4a][\W_]*[kc]?[\W_]*[e3][\W_]*d([^a-z0-9]|$)/i, label: "adult" },
  { name: "b00bs", re: /(^|[^a-z0-9])b[\W_]*[0o][\W_]*[0o][\W_]*b[s]?([^a-z0-9]|$)/i, label: "adult" },
  { name: "0nlyf4ns", re: /(^|[^a-z0-9])[0o][\W_]*n[\W_]*l[\W_]*y[\W_]*f[\W_]*[4a][\W_]*n[\W_]*s([^a-z0-9]|$)/i, label: "adult" },
];

const ADULT_CATEGORIES = [
  "adult", "adult sex toys", "sex products", "intimates & sex toys",
  "sexy lingerie sets", "adult toys", "erotic lingerie",
];
const SENSITIVE_CATEGORIES = [
  "lingerie", "intimates", "underwear women", "sleepwear sexy",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compile(kw) {
  const body = kw.includes("\\") ? kw : escapeRegex(kw);
  const isAsciiSafe = /^[\x00-\x7F\\\s.+()*]+$/.test(kw);
  if (isAsciiSafe) {
    return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i");
  }
  return new RegExp(body, "i");
}
const BLOCKED_REGEX = BLOCKED_KEYWORDS.map((kw) => ({ kw, re: compile(kw) }));
const ADULT_REGEX = ADULT_KEYWORDS.map((kw) => ({ kw, re: compile(kw) }));
const SENSITIVE_REGEX = SENSITIVE_KEYWORDS.map((kw) => ({ kw, re: compile(kw) }));

function stripHtml(s) {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ");
}
function classifyText({ title, description, category }) {
  const text = `${stripHtml(title || "")}  ${stripHtml(description || "")}`.toLowerCase();
  const cat = (category || "").toLowerCase().trim();
  const signals = {};
  const reasons = [];

  const blockedHits = [];
  for (const { kw, re } of BLOCKED_REGEX) if (re.test(text)) blockedHits.push(kw);
  if (blockedHits.length > 0) {
    signals.blocked_hits = blockedHits;
    reasons.push(`blocked:${blockedHits[0]}`);
    return { label: "blocked", reasons, signals };
  }

  if (cat && ADULT_CATEGORIES.some((c) => cat === c || cat.includes(c))) {
    signals.category_match = cat;
    reasons.push(`adult-category:${cat}`);
    return { label: "adult", reasons, signals };
  }

  const adultHits = [];
  for (const { kw, re } of ADULT_REGEX) if (re.test(text)) adultHits.push(kw);
  if (adultHits.length > 0) {
    signals.adult_hits = adultHits;
    reasons.push(`adult:${adultHits[0]}`);
    return { label: "adult", reasons, signals };
  }

  const obfHits = [];
  let obfLabel = "safe";
  for (const { name, re, label } of OBFUSCATION_PATTERNS) {
    if (re.test(text)) {
      obfHits.push(name);
      if (label === "adult") obfLabel = "adult";
      else if (obfLabel !== "adult" && label === "sensitive") obfLabel = "sensitive";
    }
  }
  if (obfLabel === "adult") {
    signals.obfuscation_hits = obfHits;
    reasons.push(`adult-obfuscation:${obfHits[0]}`);
    return { label: "adult", reasons, signals };
  }

  if (cat && SENSITIVE_CATEGORIES.some((c) => cat === c || cat.includes(c))) {
    signals.category_match = cat;
    reasons.push(`sensitive-category:${cat}`);
    return { label: "sensitive", reasons, signals };
  }

  const sensHits = [];
  for (const { kw, re } of SENSITIVE_REGEX) if (re.test(text)) sensHits.push(kw);
  if (sensHits.length > 0 || obfLabel === "sensitive") {
    if (obfHits.length > 0) signals.obfuscation_hits = obfHits;
    if (sensHits.length > 0) signals.sensitive_hits = sensHits;
    reasons.push(`sensitive:${sensHits[0] || obfHits[0]}`);
    return { label: "sensitive", reasons, signals };
  }

  reasons.push("safe");
  return { label: "safe", reasons, signals };
}

// ===== Main =====
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const INCREMENTAL = args.includes("--incremental");
const BATCH = parseInt((args.find((x) => x.startsWith("--batch=")) || "--batch=500").split("=")[1], 10);
const LIMIT = parseInt((args.find((x) => x.startsWith("--limit=")) || "--limit=0").split("=")[1], 10);
const DRIFT_HOURS = parseInt((args.find((x) => x.startsWith("--drift-hours=")) || "--drift-hours=24").split("=")[1], 10);

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  console.log(`[backfill] mode=${DRY ? "DRY-RUN" : "WRITE"} incremental=${INCREMENTAL} batch=${BATCH} limit=${LIMIT || "ALL"} drift_hours=${DRIFT_HOURS}`);

  const baseFilter = INCREMENTAL
    ? `WHERE EXISTS (
         SELECT 1 FROM product_safety_labels psl
          WHERE psl.product_id = mp.id
            AND psl.reviewed_by_human IS NOT TRUE
            AND mp.updated_at > psl.classified_at + interval '${DRIFT_HOURS} hours'
       ) OR NOT EXISTS (
         SELECT 1 FROM product_safety_labels psl WHERE psl.product_id = mp.id
       )`
    : "";

  const { rows: totalRow } = await pool.query(
    `SELECT count(*)::int AS n FROM marketplace_products mp ${baseFilter}`
  );
  const total = LIMIT > 0 ? Math.min(LIMIT, totalRow[0].n) : totalRow[0].n;
  console.log(`[backfill] total to process: ${total}`);

  let processed = 0;
  let lastId = "00000000-0000-0000-0000-000000000000";
  const stats = { safe: 0, sensitive: 0, adult: 0, blocked: 0 };

  // Cursor-based pagination — required when WHERE filter changes after each UPDATE.
  const cursorFilter = INCREMENTAL
    ? `WHERE mp.id > $2 AND (
         EXISTS (
           SELECT 1 FROM product_safety_labels psl
            WHERE psl.product_id = mp.id
              AND psl.reviewed_by_human IS NOT TRUE
              AND mp.updated_at > psl.classified_at + interval '${DRIFT_HOURS} hours'
         ) OR NOT EXISTS (
           SELECT 1 FROM product_safety_labels psl WHERE psl.product_id = mp.id
         )
       )`
    : "WHERE mp.id > $2";

  while (processed < total) {
    const take = Math.min(BATCH, total - processed);
    const { rows } = await pool.query(
      `SELECT mp.id, mp.title, mp.description, mp.category, mp.canonical_category
       FROM marketplace_products mp
       ${cursorFilter}
       ORDER BY mp.id
       LIMIT $1`,
      [take, lastId]
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      const result = classifyText({
        title: r.title,
        description: r.description,
        category: r.canonical_category || r.category,
      });
      stats[result.label]++;

      if (DRY) continue;

      await pool.query(
        `INSERT INTO product_safety_labels (product_id, label, classifier_version, signals, reasons, classified_at)
         VALUES ($1, $2, 'v2', $3::jsonb, $4, now())
         ON CONFLICT (product_id) DO UPDATE
           SET label = EXCLUDED.label,
               classifier_version = EXCLUDED.classifier_version,
               signals = EXCLUDED.signals,
               reasons = EXCLUDED.reasons,
               classified_at = now()
           WHERE product_safety_labels.reviewed_by_human = FALSE`,
        [r.id, result.label, JSON.stringify(result.signals), result.reasons]
      );
    }

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    if (processed % 2000 < BATCH || processed >= total) {
      console.log(`[backfill] ${processed}/${total} — ${JSON.stringify(stats)}`);
    }
  }

  console.log(`[backfill] DONE. Final stats:`, stats);
  await pool.end();
}

main().catch((err) => {
  console.error("[backfill] FATAL:", err);
  process.exit(1);
});
