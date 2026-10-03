#!/usr/bin/env node
/**
 * LLM-based taxonomy reclassification — DRY RUN.
 * Reads all marketplace_products and proposes a taxonomy_node_slug for each
 * using GitHub Models gpt-4o-mini. Writes proposal to /tmp/taxonomy-proposal.json.
 * Does NOT touch the database.
 *
 * Env required: DATABASE_URL, GITHUB_TOKEN (or GITHUB_MODELS_TOKEN),
 *               GITHUB_MODELS_ENDPOINT (default: https://models.github.ai/inference)
 */

import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const TOKENS = (process.env.GITHUB_MODELS_TOKENS || process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);
let tokIdx = 0;
function nextToken() { const t = TOKENS[tokIdx % TOKENS.length]; tokIdx++; return t; }
const GH_ENDPOINT = process.env.GITHUB_MODELS_ENDPOINT || 'https://api.githubcopilot.com';
const MODEL = process.env.CLASSIFY_MODEL || 'gpt-4o-mini';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);
const OUT_FILE = process.env.OUT_FILE || '/tmp/taxonomy-proposal.json';

if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
if (!TOKENS.length) { console.error('GITHUB_MODELS_TOKENS missing'); process.exit(1); }
console.log(`[classify] tokens=${TOKENS.length}`);

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadTaxonomy() {
  const { rows } = await pool.query(
    `SELECT slug, kind, parent_slug
       FROM taxonomy_nodes
      WHERE is_active = true
      ORDER BY kind, slug`
  );
  return rows;
}

async function loadProducts() {
  const { rows } = await pool.query(
    `SELECT id, title, taxonomy_node_slug, taxonomy_unresolved,
            taxonomy_department, taxonomy_category, taxonomy_subcategory, taxonomy_leaf,
            classification_confidence
       FROM marketplace_products
      WHERE status IN ('active','draft')
      ORDER BY id`
  );
  return rows;
}

function buildTaxonomyText(nodes) {
  // Tree-like view grouped by department.
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

const SYSTEM_PROMPT = (taxonomy) => `You classify e-commerce product titles into a fixed taxonomy.

The taxonomy has THREE levels: department -> category -> subcategory.
Each level has a unique slug. Department slugs are short ("fashion"). Category slugs include the department ("fashion-women"). Subcategory slugs include the category ("fashion-women-dresses").

ALWAYS pick the MOST SPECIFIC valid slug from the taxonomy below. Prefer a subcategory; if no subcategory fits clearly, pick the parent category; if no category fits, pick the department. If NOTHING fits, return slug = "other".

Be strict about gender: a hoodie marketed for both men+women but listed under fashion-women context goes to fashion-women if the product is feminine, else fashion-men. T-shirts go to *-tshirts, hoodies to *-hoodies. Phone cases go to electronics-phones-cases. Solenoid relays / car parts go to auto-parts. Sex toys / wellness / personal-care medical → health-personal. Eyelashes → beauty-makeup-eyes, lipstick → beauty-makeup-lips, foundation/contour brushes → beauty-makeup-face, eyeliner brushes / mascara → beauty-makeup-eyes.

OUTPUT: STRICT JSON ONLY, no prose. Shape:
{"results":[{"id":"<uuid>","slug":"<chosen-slug>","confidence":0.0-1.0,"unresolved":bool,"reasoning":"<short>"}]}

unresolved=true ONLY when slug="other" or when you are uncertain between completely different departments.

TAXONOMY:
${taxonomy}
`;

async function classifyBatch(taxonomyText, batch) {
  const userMsg = JSON.stringify({
    products: batch.map((p) => ({
      id: p.id,
      title: p.title,
      hints: {
        dep: p.taxonomy_department,
        cat: p.taxonomy_category,
        sub: p.taxonomy_subcategory,
        leaf: p.taxonomy_leaf,
        currentSlug: p.taxonomy_node_slug,
      },
    })),
  });

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(taxonomyText) },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.0,
    response_format: { type: 'json_object' },
    max_tokens: 1200,
  };

  let res, data, lastErr;
  const maxAttempts = TOKENS.length * 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tok = nextToken();
    res = await fetch(`${GH_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Editor-Version': 'vscode/1.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) { data = await res.json(); break; }
    lastErr = `LLM ${res.status}: ${(await res.text()).slice(0,200)}`;
    if (res.status === 403 || res.status === 429) {
      const waitMs = 2000 + attempt * 1500;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(lastErr);
  }
  if (!data) throw new Error(lastErr || 'all attempts failed');
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new Error(`Bad JSON from LLM: ${content.slice(0, 300)}`); }
  return parsed?.results || [];
}

async function main() {
  console.log('[classify] loading taxonomy + products…');
  const [nodes, products] = await Promise.all([loadTaxonomy(), loadProducts()]);
  console.log(`[classify] taxonomy=${nodes.length} nodes, products=${products.length}`);

  const taxonomyText = buildTaxonomyText(nodes);
  const validSlugs = new Set(nodes.map((n) => n.slug));
  validSlugs.add('other');

  const proposals = [];
  const errors = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    process.stdout.write(`[classify] batch ${i / BATCH_SIZE + 1}/${Math.ceil(products.length / BATCH_SIZE)} (${batch.length} products)… `);
    try {
      const results = await classifyBatch(taxonomyText, batch);
      const byId = new Map(results.map((r) => [r.id, r]));
      for (const p of batch) {
        const r = byId.get(p.id);
        if (!r) {
          errors.push({ id: p.id, title: p.title, error: 'no_result_from_llm' });
          continue;
        }
        const slugValid = validSlugs.has(r.slug);
        proposals.push({
          id: p.id,
          title: p.title,
          current_slug: p.taxonomy_node_slug,
          current_unresolved: p.taxonomy_unresolved,
          proposed_slug: slugValid ? r.slug : null,
          confidence: r.confidence ?? null,
          unresolved: r.unresolved ?? !slugValid,
          reasoning: r.reasoning || '',
          invalid_slug_returned: slugValid ? null : r.slug,
        });
      }
      console.log('OK');
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      for (const p of batch) errors.push({ id: p.id, title: p.title, error: e.message });
    }
  }

  // Summary
  let changed = 0, unchanged = 0, nowResolved = 0, nowUnresolved = 0;
  const deptDist = {};
  for (const p of proposals) {
    if (p.current_slug !== p.proposed_slug) changed++; else unchanged++;
    if (p.current_unresolved && !p.unresolved) nowResolved++;
    if (!p.current_unresolved && p.unresolved) nowUnresolved++;
    const dept = (p.proposed_slug || 'other').split('-')[0];
    deptDist[dept] = (deptDist[dept] || 0) + 1;
  }

  const out = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    total: products.length,
    classified: proposals.length,
    errors: errors.length,
    summary: { changed, unchanged, nowResolved, nowUnresolved, deptDist },
    proposals,
    errors_detail: errors,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\n[classify] wrote ${OUT_FILE}`);
  console.log(`[classify] total=${products.length} classified=${proposals.length} errors=${errors.length}`);
  console.log(`[classify] changed=${changed} unchanged=${unchanged} now_resolved=${nowResolved} now_unresolved=${nowUnresolved}`);
  console.log(`[classify] dept distribution:`, deptDist);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
