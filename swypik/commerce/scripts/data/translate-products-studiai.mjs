#!/usr/bin/env node
/**
 * Batch-translate marketplace_products into one or more locales using StudiAI.
 * Targets products that lack a product_translations row for the requested locale.
 *
 * Usage:
 *   DRY:   node scripts/translate-products-studiai.mjs --locale=ro --limit=20
 *   APPLY: node scripts/translate-products-studiai.mjs --locale=ro --limit=2000 --apply
 *
 * Env:
 *   DATABASE_URL          (required)
 *   STUDIAI_API_KEY       or STUDIAI_API_KEYS=key1,key2,...
 *   STUDIAI_BASE_URL      default https://ai.studiai.ro/v1
 *   STUDIAI_MODEL         default claude-opus-4-7
 *   BATCH_SIZE            default 8 (products per LLM call)
 *   INTER_BATCH_MS        default 500
 *   CONCURRENCY           default 2 (parallel batches)
 *   SOURCE_LOCALE         default en (canonical AE language)
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const { Pool } = pg;

function contentHash(title, description) {
  return createHash('sha256')
    .update(`${title || ''}\u0000${description || ''}`)
    .digest('hex')
    .slice(0, 16);
}

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-opus-4-7';
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'v2.1';
const MODEL_TAG = `${MODEL}-prompt-${PROMPT_VERSION}`;
const TIER_ENABLED = process.env.TIER_ENABLED === '1';
// StudiAI mirror oferă doar claude-opus-4-7 + claude-haiku-4-5 (verified 2026-05-28).
const TIER_MODELS = {
  opus: process.env.STUDIAI_MODEL_OPUS || 'claude-opus-4-7',
  haiku: process.env.STUDIAI_MODEL_HAIKU || 'claude-haiku-4-5',
};
const TIER_OPUS_ORDERS = Number(process.env.TIER_OPUS_ORDERS || 100);
const TIER_OPUS_RATING = Number(process.env.TIER_OPUS_RATING || 4.7);
// Per-tier prompt version: opus performs best with v2.1 (90% in 145-160), haiku needs v2.2 (slug language fix)
const TIER_PROMPTS = {
  opus: process.env.TIER_PROMPT_OPUS || 'v2.1',
  haiku: process.env.TIER_PROMPT_HAIKU || 'v2.2',
};
function pickTier(ordersCount, rating) {
  const o = Number(ordersCount) || 0;
  const r = Number(rating) || 0;
  if (o >= TIER_OPUS_ORDERS || r >= TIER_OPUS_RATING) return 'opus';
  return 'haiku';
}
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);
const INTER_BATCH_MS = Number(process.env.INTER_BATCH_MS || 500);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const SOURCE_LOCALE = process.env.SOURCE_LOCALE || 'en';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const TARGET_LOCALE = (args.locale || 'ro').toLowerCase();
const LIMIT = Number(args.limit || 100);
const APPLY = args.apply === true || args.apply === 'true';

function getKeys() {
  if (process.env.STUDIAI_API_KEYS) return process.env.STUDIAI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  return process.env.STUDIAI_API_KEY ? [process.env.STUDIAI_API_KEY.trim()] : [];
}
const KEYS = getKeys();
let _rr = 0;
function pickKey() { return KEYS[_rr++ % KEYS.length]; }

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (KEYS.length === 0) { console.error('STUDIAI_API_KEY[S] missing'); process.exit(1); }

console.log(`[translate] mode=${APPLY ? 'APPLY' : 'DRY'} target=${TARGET_LOCALE} source=${SOURCE_LOCALE} limit=${LIMIT} batch=${BATCH_SIZE} concurrency=${CONCURRENCY} keys=${KEYS.length}`);

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const LOCALE_LABELS = {
  ro: 'Romanian (limba română)',
  en: 'English',
  es: 'Spanish (español)',
  fr: 'French (français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (português)',
  it: 'Italian (italiano)',
};

const SLUG_MAX_LENGTH = 90;

// Fallback phrases per locale for padding short seo_descriptions to >= SEO_MIN.
// Used when LLM (esp. haiku) returns sd_len < 140; append non-repeating phrases until in range.
const SEO_MIN = 140;
const SEO_TARGET = 150;
const SEO_MAX = 165;
const SEO_PAD_PHRASES = {
  ro: [' Livrare rapidă.', ' Calitate premium.', ' Ideal pentru cadou.', ' Stoc limitat.'],
  en: [' Fast shipping.', ' Premium quality.', ' Great gift idea.', ' Limited stock.'],
  es: [' Envío rápido.', ' Calidad premium.', ' Ideal para regalo.', ' Stock limitado.'],
  fr: [' Livraison rapide.', ' Qualité premium.', ' Idéal cadeau.', ' Stock limité.'],
  de: [' Schneller Versand.', ' Premium-Qualität.', ' Ideal als Geschenk.', ' Begrenzt verfügbar.'],
  pt: [' Envio rápido.', ' Qualidade premium.', ' Ideal para presente.', ' Estoque limitado.'],
  it: [' Spedizione rapida.', ' Qualità premium.', ' Idea regalo.', ' Stock limitato.'],
};

function padSeoDescription(text, locale) {
  if (!text) return text;
  let s = String(text).trim();
  if (s.length >= SEO_MIN) return s.slice(0, SEO_MAX);
  const phrases = SEO_PAD_PHRASES[locale] || SEO_PAD_PHRASES.en;
  const sLow = s.toLowerCase();
  // Append each phrase at most once, skipping ones whose key tokens already appear in source text.
  const used = new Set();
  for (const p of phrases) {
    if (s.length >= SEO_TARGET) break;
    if (s.length + p.length > SEO_MAX) continue;
    // strip leading/trailing spaces + period for dup check
    const key = p.trim().replace(/\.$/, '').toLowerCase();
    if (used.has(p) || sLow.includes(key)) continue;
    s = (s + p).trim();
    used.add(p);
  }
  return s.slice(0, SEO_MAX);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
}

function productIdSuffix(productId, length = 12) {
  const compact = String(productId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact) return compact.slice(0, length);
  return createHash('sha1').update(String(productId || '')).digest('hex').slice(0, length);
}

function slugWithSuffix(baseSlug, suffix) {
  const cleanSuffix = String(suffix || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'item';
  const base = slugify(baseSlug) || 'product';
  const maxBaseLength = Math.max(1, SLUG_MAX_LENGTH - cleanSuffix.length - 1);
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, '') || 'product';
  return `${trimmedBase}-${cleanSuffix}`;
}

function buildSlugCandidates(productId, translation) {
  const shortSuffix = productIdSuffix(productId, 12);
  const longSuffix = productIdSuffix(productId, 32);
  const baseSlug = slugify(translation.slug || translation.title || '') || slugWithSuffix('product', shortSuffix);
  return [...new Set([
    baseSlug,
    slugWithSuffix(baseSlug, shortSuffix),
    slugWithSuffix(baseSlug, longSuffix),
    slugWithSuffix('product', longSuffix),
  ])];
}

async function slugConflictExists(productId, locale, slug) {
  const { rowCount } = await pool.query(
    `SELECT 1
       FROM product_translations
      WHERE locale = $1
        AND slug = $2
        AND product_id <> $3
      LIMIT 1`,
    [locale, slug, productId],
  );
  return rowCount > 0;
}

function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fenced ? fenced[1] : trimmed;
  try { return JSON.parse(payload); } catch {}
  const f = payload.indexOf('{');
  const l = payload.lastIndexOf('}');
  if (f >= 0 && l > f) { try { return JSON.parse(payload.slice(f, l + 1)); } catch {} }
  return null;
}

// Load prompt from versioned file. Falls back to inline v1 if file missing (defensive).
function loadSystemPrompt(version) {
  const v = version || PROMPT_VERSION;
  const promptPath = process.env.PROMPT_FILE
    || path.join(process.cwd(), 'scripts', 'translator', 'prompts', `${v}-system.txt`);
  try {
    const tpl = fs.readFileSync(promptPath, 'utf8');
    return tpl
      .replace(/\{SOURCE_LOCALE\}/g, LOCALE_LABELS[SOURCE_LOCALE] || SOURCE_LOCALE)
      .replace(/\{TARGET_LOCALE\}/g, LOCALE_LABELS[TARGET_LOCALE] || TARGET_LOCALE);
  } catch (e) {
    console.warn(`[translate] prompt file ${promptPath} missing, using inline v1 fallback`);
    return `You translate e-commerce product listings from ${LOCALE_LABELS[SOURCE_LOCALE]} into ${LOCALE_LABELS[TARGET_LOCALE]}.

For EACH product, produce SEO-friendly localized fields:
- title (60-95 chars, no ALL-CAPS, no emoji)
- description (200-600 chars)
- seo_title (50-60 chars HARD)
- seo_description (140-160 chars HARD)
- slug (lowercase, hyphenated ASCII, max 90 chars)

PRESERVE brand names, model codes, quantities (1Pcs → "1 buc"), numeric specs exactly.
NEVER invent features, prices, certifications.

Return strict JSON only:
{"results":[{"id":"<uuid>","title":"...","description":"...","seo_title":"...","seo_description":"...","slug":"..."}]}`;
  }
}
const SYSTEM = loadSystemPrompt();
// Cache per-tier prompts (only loaded when TIER_ENABLED)
const SYSTEM_BY_TIER = TIER_ENABLED ? {
  opus: loadSystemPrompt(TIER_PROMPTS.opus),
  haiku: loadSystemPrompt(TIER_PROMPTS.haiku),
} : null;
if (TIER_ENABLED) {
  console.log(`[translate] TIER mode ON — opus=${TIER_MODELS.opus}/${TIER_PROMPTS.opus} haiku=${TIER_MODELS.haiku}/${TIER_PROMPTS.haiku} (cutoff: orders>=${TIER_OPUS_ORDERS} OR rating>=${TIER_OPUS_RATING})`);
} else {
  console.log(`[translate] prompt_version=${PROMPT_VERSION} model_tag=${MODEL_TAG} system_len=${SYSTEM.length}`);
}

// Light validation (no Zod dep in this batch script — use plain checks)
function validateResult(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.id !== 'string' || !r.id) return false;
  return validateTranslationFields(r);
}

function validateTranslationFields(result) {
  const r = result || {};
  if (typeof r.title !== 'string' || r.title.length < 10 || r.title.length > 250) return false;
  if (r.description != null && (typeof r.description !== 'string' || r.description.length > 2000)) return false;
  if (r.seo_title != null && (typeof r.seo_title !== 'string' || r.seo_title.length > 80)) return false;
  if (r.seo_description != null && (typeof r.seo_description !== 'string' || r.seo_description.length > 220)) return false;
  if (r.slug != null && typeof r.slug !== 'string') return false;
  return true;
}

async function callLLM(batch, modelOverride, systemOverride) {
  const userMsg = JSON.stringify({
    products: batch.map((p) => ({
      id: p.id,
      title: p.title,
      description: (p.description || '').slice(0, 800),
    })),
  });
  const body = {
    model: modelOverride || MODEL,
    messages: [
      { role: 'system', content: systemOverride || SYSTEM },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = pickKey();
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = `network: ${e.message}`;
      await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '{}';
      const parsed = parseJsonLoose(text);
      return Array.isArray(parsed?.results) ? parsed.results : [];
    }
    lastErr = `studiai ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 + attempt * 3000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr || 'all attempts failed');
}

async function writeOne(productId, translation, sourceTitle, sourceDescription, modelTagOverride) {
  const slugCandidates = buildSlugCandidates(productId, translation);
  // Pad seo_description if under 140 chars (esp. for haiku which often undershoots)
  const sdPadded = translation.seo_description ? padSeoDescription(String(translation.seo_description).slice(0, 220), TARGET_LOCALE) : null;
  let lastErr;
  for (const slug of slugCandidates) {
    if (await slugConflictExists(productId, TARGET_LOCALE, slug)) continue;
    try {
      await pool.query(
        `INSERT INTO product_translations
           (product_id, locale, title, description, slug, seo_title, seo_description, source, model_tag, source_content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'llm', $8, $9)
         ON CONFLICT (product_id, locale) DO UPDATE
           SET title = EXCLUDED.title,
               description = EXCLUDED.description,
               slug = EXCLUDED.slug,
               seo_title = EXCLUDED.seo_title,
               seo_description = EXCLUDED.seo_description,
               source = CASE WHEN product_translations.source = 'seller' THEN 'seller' ELSE 'llm' END,
               model_tag = EXCLUDED.model_tag,
               source_content_hash = EXCLUDED.source_content_hash`,
        [
          productId,
          TARGET_LOCALE,
          String(translation.title || '').slice(0, 250),
          translation.description ? String(translation.description).slice(0, 2000) : null,
          slug,
          translation.seo_title ? String(translation.seo_title).slice(0, 80) : null,
          sdPadded,
          modelTagOverride || MODEL_TAG,
          contentHash(sourceTitle, sourceDescription),
        ],
      );
      return;
    } catch (e) {
      lastErr = e;
      if (e?.code !== '23505' || !String(e.constraint || '').includes('slug')) throw e;
    }
  }
  throw lastErr || new Error(`unable to allocate unique slug for product ${productId}`);
}

async function loadCandidates() {
  // When tier mode is on, split LIMIT proportionally between opus and haiku candidates
  // (otherwise high-orders backlog hogs all opus and haiku savings never kick in).
  if (TIER_ENABLED) {
    const opusRatio = Number(process.env.TIER_OPUS_RATIO || 0.5);
    const opusLimit = Math.max(1, Math.floor(LIMIT * opusRatio));
    const haikuLimit = Math.max(1, LIMIT - opusLimit);
    const tierWhere = `(COALESCE(p.orders_count_int, 0) >= ${TIER_OPUS_ORDERS} OR COALESCE(p.rating_numeric, 0) >= ${TIER_OPUS_RATING})`;
    const baseQ = (filter, limit) => pool.query(
      `SELECT p.id, p.title, p.description,
              p.orders_count_int AS orders_count,
              p.rating_numeric AS rating
         FROM marketplace_products p
         LEFT JOIN product_translations t
           ON t.product_id = p.id AND t.locale = $1
        WHERE p.status = 'active'
          AND COALESCE(p.title, '') <> ''
          AND t.product_id IS NULL
          AND ${filter}
        ORDER BY p.orders_count_int DESC NULLS LAST, p.updated_at DESC
        LIMIT $2`,
      [TARGET_LOCALE, limit],
    );
    const [opusRes, haikuRes] = await Promise.all([
      baseQ(tierWhere, opusLimit),
      baseQ(`NOT ${tierWhere}`, haikuLimit),
    ]);
    const rows = [...opusRes.rows, ...haikuRes.rows];
    for (const r of rows) r._tier = pickTier(r.orders_count, r.rating);
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.description,
            p.orders_count_int AS orders_count,
            p.rating_numeric AS rating
       FROM marketplace_products p
       LEFT JOIN product_translations t
         ON t.product_id = p.id AND t.locale = $1
      WHERE p.status = 'active'
        AND COALESCE(p.title, '') <> ''
        AND t.product_id IS NULL
      ORDER BY p.orders_count_int DESC NULLS LAST, p.updated_at DESC
      LIMIT $2`,
    [TARGET_LOCALE, LIMIT],
  );
  return rows;
}

async function processBatches(batches) {
  let applied = 0;
  let failed = 0;
  let inFlight = 0;
  let idx = 0;
  await new Promise((resolve) => {
    const next = () => {
      if (idx >= batches.length && inFlight === 0) return resolve();
      while (inFlight < CONCURRENCY && idx < batches.length) {
        const myBatch = batches[idx++];
        const tag = `[batch ${idx}/${batches.length}]`;
        inFlight++;
        (async () => {
          const batchTier = TIER_ENABLED ? (myBatch[0]?._tier || 'opus') : null;
          const batchModel = TIER_ENABLED ? TIER_MODELS[batchTier] : MODEL;
          const batchPrompt = TIER_ENABLED ? TIER_PROMPTS[batchTier] : PROMPT_VERSION;
          const batchSystem = TIER_ENABLED ? SYSTEM_BY_TIER[batchTier] : SYSTEM;
          const batchModelTag = TIER_ENABLED ? `${batchModel}-prompt-${batchPrompt}` : MODEL_TAG;
          try {
            const results = await callLLM(myBatch, batchModel, batchSystem);
            const byId = new Map(results.map((result) => [String(result.id), result]));
            const canFallbackByIndex = results.length === myBatch.length;
            let ok = 0;
            for (let batchIndex = 0; batchIndex < myBatch.length; batchIndex++) {
              const p = myBatch[batchIndex];
              let r = byId.get(String(p.id));
              if (!validateResult(r) && canFallbackByIndex && validateTranslationFields(results[batchIndex])) {
                r = { ...results[batchIndex], id: String(p.id) };
                console.log(`${tag} fallback by index for ${p.id} (model=${batchModel})`);
              }
              if (!validateResult(r)) {
                failed++;
                if (r) console.log(`${tag} schema reject ${p.id}: title_len=${r.title?.length || 0} st_len=${r.seo_title?.length || 0}`);
                else console.log(`${tag} missing id ${p.id} in LLM response (model=${batchModel})`);
                continue;
              }
              if (APPLY) {
                try { await writeOne(p.id, r, p.title, p.description, batchModelTag); ok++; applied++; }
                catch (e) { console.log(`${tag} db fail ${p.id}: ${e.message}`); failed++; }
              } else {
                ok++;
                console.log(`${tag} would translate [${batchModel}]: "${p.title.slice(0,50)}" → "${(r.title||'').slice(0,60)}"`);
              }
            }
            console.log(`${tag} model=${batchModel} ok=${ok}/${myBatch.length}`);
          } catch (e) {
            console.log(`${tag} batch fail: ${e.message}`);
            failed += myBatch.length;
          } finally {
            inFlight--;
            if (INTER_BATCH_MS > 0) await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
            next();
          }
        })();
      }
    };
    next();
  });
  return { applied, failed };
}

async function main() {
  const candidates = await loadCandidates();
  console.log(`[translate] candidates=${candidates.length}`);
  if (!candidates.length) { await pool.end(); return; }

  const batches = [];
  if (TIER_ENABLED) {
    const byTier = { opus: [], haiku: [] };
    for (const c of candidates) byTier[c._tier].push(c);
    const tierBatches = { opus: [], haiku: [] };
    for (const tier of ['opus', 'haiku']) {
      const list = byTier[tier];
      console.log(`[translate] tier=${tier} model=${TIER_MODELS[tier]} candidates=${list.length}`);
      for (let i = 0; i < list.length; i += BATCH_SIZE) tierBatches[tier].push(list.slice(i, i + BATCH_SIZE));
    }
    // Interleave opus+haiku batches round-robin so concurrent workers process a mix of both tiers
    // (avoids sequential "all opus first, all haiku last" which delays haiku throughput).
    const maxLen = Math.max(tierBatches.opus.length, tierBatches.haiku.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < tierBatches.opus.length) batches.push(tierBatches.opus[i]);
      if (i < tierBatches.haiku.length) batches.push(tierBatches.haiku[i]);
    }
  } else {
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }
  }
  const { applied, failed } = await processBatches(batches);
  console.log(`[translate] DONE applied=${applied} failed=${failed} of ${candidates.length}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
