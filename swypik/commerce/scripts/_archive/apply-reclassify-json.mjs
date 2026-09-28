#!/usr/bin/env node
/**
 * Apply previously-generated reclassification proposals from JSON
 * (avoids re-calling the LLM). Use after running reclassify-unresolved-studiai.mjs (DRY).
 *
 * Usage: node scripts/apply-reclassify-json.mjs [--file=/tmp/reclassify-unresolved.json]
 */
import pg from 'pg';
import fs from 'node:fs';
const { Pool } = pg;

const FILE = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1] || '/tmp/reclassify-unresolved.json';
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.55);
const MODEL_TAG = process.env.MODEL_TAG || 'claude-opus-4-7';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const { rows: nodes } = await pool.query(`SELECT slug FROM taxonomy_nodes WHERE is_active=true`);
  const validSlugs = new Set(nodes.map((n) => n.slug));
  validSlugs.add('other');

  let applied = 0, skippedConf = 0, skippedOther = 0, skippedInvalid = 0, skippedErr = 0;
  for (const p of data.proposals) {
    if (p.error || !p.proposed_slug) { skippedErr++; continue; }
    if (!validSlugs.has(p.proposed_slug)) { skippedInvalid++; continue; }
    if (p.proposed_slug === 'other') { skippedOther++; continue; }
    if (p.unresolved === true) { skippedConf++; continue; }
    if ((p.confidence ?? 0) < MIN_CONFIDENCE) { skippedConf++; continue; }
    await pool.query(
      `UPDATE marketplace_products
          SET taxonomy_node_slug=$1,
              taxonomy_unresolved=false,
              classification_confidence=$2,
              classification_reason=$3,
              taxonomy_reason=$4,
              updated_at=now()
        WHERE id=$5 AND taxonomy_unresolved=true`,
      [p.proposed_slug, p.confidence ?? null, (p.reasoning || '').slice(0, 500) || null, `llm_reclassify_${MODEL_TAG}`, p.id]
    );
    applied++;
  }
  console.log(`applied=${applied} skipped_conf=${skippedConf} skipped_other=${skippedOther} skipped_invalid=${skippedInvalid} skipped_err=${skippedErr}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
