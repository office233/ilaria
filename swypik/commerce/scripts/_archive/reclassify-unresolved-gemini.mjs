#!/usr/bin/env node
/**
 * Reclassify products flagged taxonomy_unresolved=true using Gemini.
 * Usage:
 *   DRY: node scripts/reclassify-unresolved-gemini.mjs
 *   APPLY: node scripts/reclassify-unresolved-gemini.mjs --apply
 *
 * Env: DATABASE_URL, GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.5-flash-lite).
 */

import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const APPLY = process.argv.includes('--apply');
const OUT_FILE = process.env.OUT_FILE || '/tmp/reclassify-unresolved.json';
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.75);

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (!KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }
console.log(`[reclassify] mode=${APPLY ? 'APPLY' : 'DRY'} model=${MODEL} batch=${BATCH_SIZE}`);

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug FROM taxonomy_nodes WHERE is_active = true ORDER BY kind, slug`
  );
  return rows;
}

async function loadProducts() {
  const { rows } = await pool.query(
    `SELECT id, title, taxonomy_node_slug, taxonomy_department, taxonomy_category, taxonomy_subcategory, taxonomy_leaf
       FROM marketplace_products
      WHERE status = 'active' AND taxonomy_unresolved = true
      ORDER BY updated_at DESC`
  );
  return rows;
}

function buildTaxonomyText(nodes) {
  const depts = nodes.filter((n) => n.kind === 'department').map((n) => n.slug).sort();
  const lines = [];
  for (const d of depts) {
    lines.push(`# ${d}`);
    const cats = nodes.filter((n) => n.kind === 'category' && n.parent_slug === d).map((n) => n.slug).sort();
    for (const c of cats) {
      lines.push(`  - ${c}`);
      const subs = nodes.filter((n) => n.kind === 'subcategory' && n.parent_slug === c).map((n) => n.slug).sort();
      for (const s of subs) lines.push(`    * ${s}`);
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = (taxonomy) => `You classify e-commerce product titles into a fixed taxonomy with three levels: department > category > subcategory.

RULES (strict):
1. The slug MUST describe what the product PRIMARILY IS — not what it is "for" (do NOT use "for iPhone" to put a cable in phone-cases; cables are NOT cases).
2. If the title says "women/woman/female/femme/dama/femme" the product belongs to fashion-women-*, NOT toys-baby, NOT home-bathroom, NOT sports.
3. If the title says "baby/infant/newborn/toddler/diaper/stroller/crib/pacifier" the product belongs to toys-baby.
4. "Jeans/Denim" -> fashion-{men,women}-jeans (NEVER fashion-*-shirts).
5. "T-shirt/Tee/Tricou" -> fashion-{men,women}-tshirts. "Shirt/Cămașă/Blouse" -> fashion-{men,women}-shirts. They are DIFFERENT.
6. "Case/Cover/Carcasă/Husă" -> electronics-phones-cases. Cables/adapters/screen protectors/hubs are NOT cases.
7. "SIM" -> electronics-phones-sim. HUBs, adapters and chargers are NOT SIM accessories.
8. "Sport/Tactical/Outdoor/Cargo/Hiking/Camping" -> sports-outdoor when actual sport gear; tactical PANTS still go to fashion-{men}-pants.
9. Bikini/Kimono/Jumpsuit/Cover-up/Sequin necklace/Choker -> fashion-women-* (NEVER toys-baby).
10. If genuinely unsure across departments, set confidence < 0.5 and unresolved=true.

OUTPUT strict JSON: {"results":[{"id":"<uuid>","slug":"<slug>","confidence":0.0-1.0,"unresolved":bool,"reasoning":"<short>"}]}.

TAXONOMY (use slug exactly):
${taxonomy}`;

async function classifyBatch(taxonomyText, batch) {
  const userMsg = JSON.stringify({
    products: batch.map((p) => ({
      id: p.id,
      title: p.title,
    })),
  });
  const body = {
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT(taxonomyText) }] },
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 4096,
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text)?.results || [];
    }
    lastErr = `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 3000 + attempt * 3000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr || 'all attempts failed');
}

async function applyOne(p, r) {
  await pool.query(
    `UPDATE marketplace_products
        SET taxonomy_node_slug = $1,
            taxonomy_unresolved = $2,
            classification_confidence = $3,
            classification_reason = $4,
            taxonomy_reason = $5,
            updated_at = now()
      WHERE id = $6`,
    [
      r.slug,
      r.unresolved === true,
      r.confidence ?? null,
      (r.reasoning || '').slice(0, 500) || null,
      `llm_reclassify_${MODEL}`,
      p.id,
    ]
  );
}

async function main() {
  const [nodes, products] = await Promise.all([loadTaxonomy(), loadProducts()]);
  console.log(`[reclassify] taxonomy=${nodes.length} nodes, unresolved_products=${products.length}`);
  if (!products.length) { console.log('Nothing to do.'); await pool.end(); return; }

  const taxonomyText = buildTaxonomyText(nodes);
  const validSlugs = new Set(nodes.map((n) => n.slug));
  validSlugs.add('other');

  const proposals = [];
  let applied = 0;
  let skipped = 0;

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const tag = `[batch ${i / BATCH_SIZE + 1}/${Math.ceil(products.length / BATCH_SIZE)}]`;
    try {
      const results = await classifyBatch(taxonomyText, batch);
      const byId = new Map(results.map((r) => [String(r.id), r]));
      let batchApplied = 0;
      for (const p of batch) {
        const r = byId.get(String(p.id));
        if (!r) { proposals.push({ id: p.id, error: 'no_result' }); skipped++; continue; }
        const slugValid = validSlugs.has(r.slug);
        const titleLower = String(p.title || '').toLowerCase();
        const slugTokens = String(r.slug || '').split('-').filter((t) => t.length > 3);
        const SLUG_KEYWORDS = {
          'jeans': ['jeans','denim'],
          'tshirts': ['t-shirt','t shirt','tshirt','tee','tricou','jersey'],
          'shirts': ['shirt','blouse','cama','chemise'],
          'shorts': ['short','bermuda'],
          'pants': ['pant','trouser','jogger','legging'],
          'dresses': ['dress','gown','rochie','robe','mariée','bridal','wedding'],
          'cases': ['case','cover','carcas','husa','sleeve','pouch','skin','bumper'],
          'sim': ['sim'],
          'baby': ['baby','infant','toddler','newborn','diaper','stroller','crib','pacifier','bebe'],
          'shoes': ['shoe','sneaker','boot','sandal','heel','pantofi','încălț','incalt','loafer'],
          'bathroom': ['bath','shower','toilet','towel','sink','faucet','baie','dush'],
          'outdoor': ['tactical','outdoor','camping','hiking','tent','backpack','fishing','hunting'],
          'makeup': ['makeup','lipstick','foundation','mascara','eyeliner','rimel','ruj'],
          'haircare': ['hair','shampoo','conditioner','beard','perii păr'],
          'fragrance': ['perfume','fragrance','cologne','parfum','eau de'],
        };
        let keywordOk = true;
        for (const tok of slugTokens) {
          const kws = SLUG_KEYWORDS[tok];
          if (!kws) continue;
          keywordOk = kws.some((kw) => titleLower.includes(kw));
          if (!keywordOk) break;
        }
        const acceptable = slugValid && (r.confidence ?? 0) >= MIN_CONFIDENCE && r.slug !== 'other' && r.unresolved !== true && keywordOk;
        proposals.push({
          id: p.id,
          title: p.title,
          proposed_slug: r.slug,
          confidence: r.confidence ?? null,
          unresolved: r.unresolved ?? !slugValid,
          reasoning: r.reasoning || '',
          will_apply: APPLY && acceptable,
        });
        if (APPLY && acceptable) { await applyOne(p, r); applied++; batchApplied++; }
        else if (APPLY) skipped++;
      }
      console.log(`${tag} ok applied=${batchApplied}/${batch.length}`);
    } catch (e) {
      console.log(`${tag} fail: ${e.message}`);
      for (const p of batch) { proposals.push({ id: p.id, title: p.title, error: e.message }); skipped++; }
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ total: products.length, applied, skipped, proposals }, null, 2));
  console.log(`[reclassify] total=${products.length} applied=${applied} skipped=${skipped}`);
  console.log(`[reclassify] wrote ${OUT_FILE}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
