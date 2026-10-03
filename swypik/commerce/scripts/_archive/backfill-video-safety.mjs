#!/usr/bin/env node
// Backfill video_safety_labels using a faithful mirror of lib/moderation/classifier.ts.
// Usage: node backfill-video-safety.mjs [--dry-run] [--batch=500] [--limit=N]
import pg from "pg";

// ====== START MIRROR OF lib/moderation/classifier.ts ======
const BLOCKED_KEYWORDS = [
  "child porn","child sex","kid sex","minor sex","underage sex",
  "lolita sex","lolita porn","loli porn","shota porn",
  "preteen sex","preteen porn","pre-teen sex",
  "schoolgirl porn","kiddie porn","jailbait",
  "rape video","revenge porn","leaked nude","hidden cam sex",
  "spycam sex","upskirt video",
  "switchblade knife","ballistic knife","gun silencer",
  "ghost gun kit","plastic explosive","c4 explosive",
  "live grenade","frag grenade",
  "cocaine","heroin","fentanyl","meth pipe","crack pipe","crystal meth",
  "fake id card","counterfeit money","fake passport","counterfeit currency",
];
const ADULT_KEYWORDS_EN = [
  "18\\+","xxx","nsfw","porn","pornographic","pornhub","onlyfans",
  "sex toy","sex toys","sex doll","sex products","sex shop",
  "vibrator","vibrators","dildo","dildos",
  "masturbator","masturbation","fleshlight",
  "bondage","bdsm","fetish gear",
  "butt plug","anal plug","anal beads","anal toy",
  "cock ring","penis ring","penis pump","penis sleeve",
  "vibrating egg","love egg",
  "g-spot","g spot",
  "personal lubricant","sex lubricant","lube sex",
  "adult only","adult-only","adults only",
  "erotic","erotica","kinky",
  "crotchless","pheromone",
  "nipple clamp","nipple pasties",
  "naked","nude photo","nude pic",
];
const ADULT_KEYWORDS_RU = ["порно","секс игрушк","секс-игрушк","вибратор","фаллоимитатор","мастурбатор","интим товар","анальн","эротик"];
const ADULT_KEYWORDS_CN = ["情趣","成人用品","性玩具","震动棒","av女优"];
const ADULT_KEYWORDS_JP = ["アダルト","セックス","オナホ","バイブ","性玩具"];
const ADULT_KEYWORDS_RO = ["produse adulti","produse pentru adulti","sex shop","jucarii sexuale","vibrator","lubrifiant intim"];
const SENSITIVE_KEYWORDS_EN = [
  "sexy","seductive","sensual","intimate wear","lingerie set",
  "thong","g-string","crotchless","fishnet","babydoll",
  "garter belt","suspender belt","bustier","corset lingerie",
  "see through","see-through","sheer lace","transparent lingerie",
  "open bra","open cup","open crotch","peek a boo",
  "bikini micro","micro bikini","sling bikini",
  "boudoir","pin up","pinup",
  "bulge","sissy","lolita dress",
];
const SENSITIVE_KEYWORDS_RU = ["сексуальн","соблазнительн","эротичн","нижнее белье женское сексуальн","интимн","пеньюар","стринги"];
const SENSITIVE_KEYWORDS_RO = ["lenjerie intima","lenjerie sexy","lenjerie erotica","ciorapi rezistenti"];
const OBFUSCATION_PATTERNS = [
  { name: "s3x", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x([^a-z0-9]|$)/i, label: "adult" },
  { name: "sxy", re: /(^|[^a-z0-9])s[\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "s3xy", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "p0rn", re: /(^|[^a-z0-9])p[\W_]*[0o][\W_]*r[\W_]*n([^a-z0-9]|$)/i, label: "adult" },
  { name: "n4de", re: /(^|[^a-z0-9])n[\W_]*[4a][\W_]*[kc]?[\W_]*[e3][\W_]*d([^a-z0-9]|$)/i, label: "adult" },
  { name: "b00bs", re: /(^|[^a-z0-9])b[\W_]*[0o][\W_]*[0o][\W_]*b[s]?([^a-z0-9]|$)/i, label: "adult" },
  { name: "0nlyf4ns", re: /(^|[^a-z0-9])[0o][\W_]*n[\W_]*l[\W_]*y[\W_]*f[\W_]*[4a][\W_]*n[\W_]*s([^a-z0-9]|$)/i, label: "adult" },
];
const ADULT_CATEGORIES = ["adult","adult sex toys","sex products","intimates & sex toys","sexy lingerie sets","adult toys","erotic lingerie"];
const SENSITIVE_CATEGORIES = ["lingerie","intimates","underwear women","sleepwear sexy"];

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function compile(kw) {
  const body = kw.includes("\\") ? kw : escapeRegex(kw);
  const isAsciiSafe = /^[\x00-\x7F\\\s.+()*]+$/.test(kw);
  if (isAsciiSafe) return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i");
  return new RegExp(body, "i");
}
const BLOCKED_REGEX = BLOCKED_KEYWORDS.map(kw => ({ kw, re: compile(kw) }));
const ADULT_REGEX = [...ADULT_KEYWORDS_EN, ...ADULT_KEYWORDS_RU, ...ADULT_KEYWORDS_CN, ...ADULT_KEYWORDS_JP, ...ADULT_KEYWORDS_RO].map(kw => ({ kw, re: compile(kw) }));
const SENSITIVE_REGEX = [...SENSITIVE_KEYWORDS_EN, ...SENSITIVE_KEYWORDS_RU, ...SENSITIVE_KEYWORDS_RO].map(kw => ({ kw, re: compile(kw) }));

function stripHtml(s) {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ");
}
function classifyText(input) {
  const text = [stripHtml(input.title||""), stripHtml(input.description||""), (input.tags||[]).join(" ")].join("  ").toLowerCase();
  const cat = (input.category||"").toLowerCase().trim();
  const signals = {};
  const reasons = [];
  const blockedHits = [];
  for (const { kw, re } of BLOCKED_REGEX) if (re.test(text)) blockedHits.push(kw);
  if (blockedHits.length) { signals.blocked_hits = blockedHits; reasons.push(`blocked:${blockedHits[0]}`); return { label: "blocked", reasons, signals }; }
  if (cat && ADULT_CATEGORIES.some(c => cat === c || cat.includes(c))) { signals.category_match = cat; reasons.push(`adult-category:${cat}`); return { label: "adult", reasons, signals }; }
  const adultHits = [];
  for (const { kw, re } of ADULT_REGEX) if (re.test(text)) adultHits.push(kw);
  if (adultHits.length) { signals.adult_hits = adultHits; reasons.push(`adult:${adultHits[0]}`); return { label: "adult", reasons, signals }; }
  const obfHits = [];
  let obfLabel = "safe";
  for (const { name, re, label } of OBFUSCATION_PATTERNS) {
    if (re.test(text)) { obfHits.push(name); if (label === "adult") obfLabel = "adult"; else if (obfLabel !== "adult" && label === "sensitive") obfLabel = "sensitive"; }
  }
  if (obfLabel === "adult") { signals.obfuscation_hits = obfHits; reasons.push(`adult-obfuscation:${obfHits[0]}`); return { label: "adult", reasons, signals }; }
  if (cat && SENSITIVE_CATEGORIES.some(c => cat === c || cat.includes(c))) { signals.category_match = cat; reasons.push(`sensitive-category:${cat}`); return { label: "sensitive", reasons, signals }; }
  const sensHits = [];
  for (const { kw, re } of SENSITIVE_REGEX) if (re.test(text)) sensHits.push(kw);
  if (sensHits.length || obfLabel === "sensitive") {
    if (obfHits.length) signals.obfuscation_hits = obfHits;
    if (sensHits.length) signals.sensitive_hits = sensHits;
    reasons.push(`sensitive:${sensHits[0] || obfHits[0]}`);
    return { label: "sensitive", reasons, signals };
  }
  reasons.push("safe");
  return { label: "safe", reasons, signals };
}
// ====== END MIRROR ======

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const batchArg = args.find(a => a.startsWith("--batch="));
const BATCH = batchArg ? parseInt(batchArg.split("=")[1], 10) : 500;
const limitArg = args.find(a => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log(`[backfill-video] mode=${dryRun ? "DRY-RUN" : "WRITE"} batch=${BATCH} limit=${LIMIT ?? "ALL"}`);
  const countRes = await pool.query(`SELECT count(*)::int AS n FROM videos`);
  const total = LIMIT ? Math.min(LIMIT, countRes.rows[0].n) : countRes.rows[0].n;
  console.log(`[backfill-video] total to process: ${total}`);

  const stats = { safe: 0, sensitive: 0, adult: 0, blocked: 0 };
  let offset = 0;
  while (offset < total) {
    const take = Math.min(BATCH, total - offset);
    const { rows } = await pool.query(
      `SELECT id, title, description, tags FROM videos ORDER BY id LIMIT $1 OFFSET $2`,
      [take, offset],
    );
    for (const r of rows) {
      const res = classifyText({ title: r.title, description: r.description, category: "", tags: r.tags });
      stats[res.label]++;
      if (!dryRun) {
        await pool.query(
          `INSERT INTO video_safety_labels (video_id, label, classifier_version, reasons, signals, classified_at)
           VALUES ($1,$2,'v2',$3,$4,now())
           ON CONFLICT (video_id) DO UPDATE SET
             label = EXCLUDED.label,
             classifier_version = EXCLUDED.classifier_version,
             reasons = EXCLUDED.reasons,
             signals = EXCLUDED.signals,
             classified_at = now(),
             updated_at = now()
           WHERE video_safety_labels.reviewed_by_human = FALSE`,
          [r.id, res.label, res.reasons, res.signals],
        );
      }
    }
    offset += rows.length;
    if (offset % 1000 === 0 || offset >= total) console.log(`[backfill-video] ${offset}/${total} — ${JSON.stringify(stats)}`);
    if (rows.length === 0) break;
  }
  console.log("[backfill-video] DONE. Final stats:", stats);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
