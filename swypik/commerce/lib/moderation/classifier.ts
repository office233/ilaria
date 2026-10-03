/**
 * Content Safety Classifier v2
 *
 * Returns a 4-level safety label for any text+category input.
 * Used at: product import, product backfill, post creation, comment, bio.
 *
 * Labels (strict order — higher wins):
 *   blocked   — illegal/hard-block content. NEVER publish anywhere.
 *   adult     — explicit sexual / 18+ content. Only allowed in Swypik 18+.
 *   sensitive — suggestive / sexualized but not explicit. Hidden from public
 *               Swypik general feed; allowed on opt-in 18+ surface.
 *   safe      — clean. Visible in main app.
 *
 * Detection layers:
 *   1. Hard-block keywords (weapons, illegal substances, CSAM-adjacent)
 *   2. Adult explicit keywords (multi-lang) — sex toys, porn, fetish
 *   3. Sensitive keywords (multi-lang) — sexy, lingerie, suggestive
 *   4. Obfuscation patterns — s3x, s.x, n4ked, sxy, p0rn, etc.
 *   5. Category-based escalation
 *
 * Returns: { label, reasons[], signals } so we can audit decisions.
 */

export type SafetyLabel = "safe" | "sensitive" | "adult" | "blocked";

export type SafetyResult = {
  label: SafetyLabel;
  reasons: string[];
  signals: {
    blocked_hits?: string[];
    adult_hits?: string[];
    sensitive_hits?: string[];
    obfuscation_hits?: string[];
    category_match?: string;
    languages_detected?: string[];
  };
};

// ----- BLOCKED (illegal / hard-block) -----
// IMPORTANT: every term must be specific enough to avoid false positives
// against legit fashion / shipping vocabulary. Avoid bare "tnt" (= courier),
// bare "explosive" (= marketing), bare "loli" (= part of "lollipop"), etc.
const BLOCKED_KEYWORDS = [
  // CSAM-adjacent (zero tolerance) — only compound forms
  "child porn", "child sex", "kid sex", "minor sex", "underage sex",
  "lolita sex", "lolita porn", "loli porn", "shota porn",
  "preteen sex", "preteen porn", "pre-teen sex",
  "schoolgirl porn", "kiddie porn", "jailbait",
  // Non-consensual
  "rape video", "revenge porn", "leaked nude", "hidden cam sex",
  "spycam sex", "upskirt video",
  // Weapons / dangerous (compound only — "switchblade" alone OK as it's a
  // restricted weapon name with no fashion overlap)
  "switchblade knife", "ballistic knife", "gun silencer",
  "ghost gun kit", "plastic explosive", "c4 explosive",
  "live grenade", "frag grenade",
  // Drugs (hard substances only — cocaine/heroin have no benign use)
  "cocaine", "heroin", "fentanyl", "meth pipe", "crack pipe", "crystal meth",
  // Counterfeit currency / IDs
  "fake id card", "counterfeit money", "fake passport", "counterfeit currency",
];

// ----- ADULT EXPLICIT (multi-language) -----
const ADULT_KEYWORDS_EN = [
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
];
const ADULT_KEYWORDS_RU = [
  "порно", "секс игрушк", "секс-игрушк", "вибратор", "фаллоимитатор",
  "мастурбатор", "интим товар", "анальн", "эротик",
];
const ADULT_KEYWORDS_CN = [
  "情趣", "成人用品", "性玩具", "震动棒", "av女优",
];
const ADULT_KEYWORDS_JP = [
  "アダルト", "セックス", "オナホ", "バイブ", "性玩具",
];
const ADULT_KEYWORDS_RO = [
  "produse adulti", "produse pentru adulti", "sex shop", "jucarii sexuale",
  "vibrator", "lubrifiant intim",
];

// ----- SENSITIVE (suggestive but not explicit) -----
// NOTE: "sexy", "seductive", "sensual" intentionally NOT in this list —
// Marketingul de import folosește aceste cuvinte pe fashion obișnuit (tops, dresses,
// lipstick, casual bodysuits). Category match + explicit terms below catch
// real lingerie. Removing those keywords downgrades ~4800 false positives.
const SENSITIVE_KEYWORDS_EN = [
  "intimate wear", "lingerie set",
  "thong", "g-string", "crotchless", "fishnet", "babydoll",
  "garter belt", "suspender belt", "bustier", "corset lingerie",
  "see through", "see-through", "sheer lace", "transparent lingerie",
  "open bra", "open cup", "open crotch", "peek a boo",
  "bikini micro", "micro bikini", "sling bikini",
  "boudoir", "pin up", "pinup",
  "bulge", "sissy", "lolita dress",
];
const SENSITIVE_KEYWORDS_RU = [
  "эротичн", "нижнее белье женское сексуальн",
  "интимн", "пеньюар", "стринги",
];
const SENSITIVE_KEYWORDS_RO = [
  "lenjerie intima", "lenjerie sexy", "lenjerie erotica", "ciorapi rezistenti",
];

// ----- OBFUSCATION patterns (regex) -----
// Catches s3xy, sxy, p0rn, n4ked, b00bs, etc. — only when they appear as
// whole tokens to avoid false positives.
const OBFUSCATION_PATTERNS: { name: string; re: RegExp; label: SafetyLabel }[] = [
  { name: "s3x", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x([^a-z0-9]|$)/i, label: "adult" },
  { name: "sxy", re: /(^|[^a-z0-9])s[\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "s3xy", re: /(^|[^a-z0-9])s[\W_]*[3e][\W_]*x[\W_]*y([^a-z0-9]|$)/i, label: "sensitive" },
  { name: "p0rn", re: /(^|[^a-z0-9])p[\W_]*[0o][\W_]*r[\W_]*n([^a-z0-9]|$)/i, label: "adult" },
  { name: "n4de", re: /(^|[^a-z0-9])n[\W_]*[4a][\W_]*[kc]?[\W_]*[e3][\W_]*d([^a-z0-9]|$)/i, label: "adult" },
  { name: "b00bs", re: /(^|[^a-z0-9])b[\W_]*[0o][\W_]*[0o][\W_]*b[s]?([^a-z0-9]|$)/i, label: "adult" },
  { name: "0nlyf4ns", re: /(^|[^a-z0-9])[0o][\W_]*n[\W_]*l[\W_]*y[\W_]*f[\W_]*[4a][\W_]*n[\W_]*s([^a-z0-9]|$)/i, label: "adult" },
];

// ----- CATEGORIES -----
const ADULT_CATEGORIES = [
  "adult", "adult sex toys", "sex products", "intimates & sex toys",
  "sexy lingerie sets", "adult toys", "erotic lingerie",
];
const SENSITIVE_CATEGORIES = [
  "lingerie", "intimates", "underwear women", "sleepwear sexy",
];

// ----- Pre-compile regexes -----
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(kw: string): RegExp {
  // Already-regex tokens like "18\+" pass through escaped; spaces kept literal.
  const body = kw.includes("\\") ? kw : escapeRegex(kw);
  // For CJK + Cyrillic, word boundaries don't work — use simple includes-style
  // (the keyword must be present as a substring).
  const isAsciiSafe = /^[\x00-\x7F\\\s.+()*]+$/.test(kw);
  if (isAsciiSafe) {
    return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i");
  }
  // CJK / Cyrillic: substring match, no boundary needed.
  return new RegExp(body, "i");
}

const BLOCKED_REGEX = BLOCKED_KEYWORDS.map((kw) => ({ kw, re: compile(kw) }));
const ADULT_REGEX = [
  ...ADULT_KEYWORDS_EN,
  ...ADULT_KEYWORDS_RU,
  ...ADULT_KEYWORDS_CN,
  ...ADULT_KEYWORDS_JP,
  ...ADULT_KEYWORDS_RO,
].map((kw) => ({ kw, re: compile(kw) }));
const SENSITIVE_REGEX = [
  ...SENSITIVE_KEYWORDS_EN,
  ...SENSITIVE_KEYWORDS_RU,
  ...SENSITIVE_KEYWORDS_RO,
].map((kw) => ({ kw, re: compile(kw) }));

export function classifyText(input: {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  tags?: string[] | null;
}): SafetyResult {
  // Strip HTML tags and decode common entities so we classify the visible
  // text, not URLs / inline CSS / CDN paths that often contain noise like
  // "tnt-cdn" (TNT courier abbreviation) or random ASCII triplets.
  const stripHtml = (s: string): string =>
    s
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/&#x?[0-9a-f]+;/gi, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\s+/g, " ");

  const parts = [
    stripHtml(input.title || ""),
    stripHtml(input.description || ""),
    (input.tags || []).join(" "),
  ];
  const text = parts.join("  ").toLowerCase();
  const cat = (input.category || "").toLowerCase().trim();

  const signals: SafetyResult["signals"] = {};
  const reasons: string[] = [];

  // Layer 1: BLOCKED — terminates immediately
  const blockedHits: string[] = [];
  for (const { kw, re } of BLOCKED_REGEX) {
    if (re.test(text)) blockedHits.push(kw);
  }
  if (blockedHits.length > 0) {
    signals.blocked_hits = blockedHits;
    reasons.push(`blocked:${blockedHits[0]}`);
    return { label: "blocked", reasons, signals };
  }

  // Layer 2: ADULT category
  if (cat && ADULT_CATEGORIES.some((c) => cat === c || cat.includes(c))) {
    signals.category_match = cat;
    reasons.push(`adult-category:${cat}`);
    return { label: "adult", reasons, signals };
  }

  // Layer 3: ADULT explicit keywords
  const adultHits: string[] = [];
  for (const { kw, re } of ADULT_REGEX) {
    if (re.test(text)) adultHits.push(kw);
  }
  if (adultHits.length > 0) {
    signals.adult_hits = adultHits;
    reasons.push(`adult:${adultHits[0]}`);
    return { label: "adult", reasons, signals };
  }

  // Layer 4: OBFUSCATION patterns
  const obfHits: string[] = [];
  let obfLabel: SafetyLabel = "safe";
  for (const { name, re, label } of OBFUSCATION_PATTERNS) {
    if (re.test(text)) {
      obfHits.push(name);
      // Escalate to highest seen
      if (label === "adult") obfLabel = "adult";
      else if (obfLabel !== "adult" && label === "sensitive") obfLabel = "sensitive";
    }
  }
  if (obfLabel === "adult") {
    signals.obfuscation_hits = obfHits;
    reasons.push(`adult-obfuscation:${obfHits[0]}`);
    return { label: "adult", reasons, signals };
  }

  // Layer 5: SENSITIVE category
  if (cat && SENSITIVE_CATEGORIES.some((c) => cat === c || cat.includes(c))) {
    signals.category_match = cat;
    reasons.push(`sensitive-category:${cat}`);
    return { label: "sensitive", reasons, signals };
  }

  // Layer 6: SENSITIVE explicit keywords
  const sensHits: string[] = [];
  for (const { kw, re } of SENSITIVE_REGEX) {
    if (re.test(text)) sensHits.push(kw);
  }
  if (sensHits.length > 0 || obfLabel === "sensitive") {
    if (obfHits.length > 0) signals.obfuscation_hits = obfHits;
    if (sensHits.length > 0) signals.sensitive_hits = sensHits;
    reasons.push(`sensitive:${sensHits[0] || obfHits[0]}`);
    return { label: "sensitive", reasons, signals };
  }

  // Layer 7: clean
  reasons.push("safe");
  return { label: "safe", reasons, signals };
}

/** Convenience: only true if label ∈ ('adult'|'blocked') */
export function isAdultLabel(label: SafetyLabel): boolean {
  return label === "adult" || label === "blocked";
}

/** Convenience: only true if label is 'safe' */
export function isPublicSafe(label: SafetyLabel): boolean {
  return label === "safe";
}
