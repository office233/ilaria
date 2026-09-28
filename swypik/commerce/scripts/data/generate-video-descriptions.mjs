#!/usr/bin/env node
/**
 * Generate short, engaging RO descriptions (1-2 sentences) for videos.
 * Uses StudiAI Haiku (cheap). Reads title + product taxonomy + price,
 * writes back to videos.description.
 *
 * Env:
 *   DATABASE_URL          (required, @postgres → @127.0.0.1 rewrite)
 *   STUDIAI_API_KEYS      comma-separated (round-robin)
 *   STUDIAI_BASE_URL      default https://ai.studiai.ro/v1
 *   STUDIAI_MODEL_HAIKU   default claude-haiku-4-5
 *   BATCH_SIZE            default 20 (videos per LLM call)
 *   MAX_VIDEOS            default 0 = all empty descriptions
 *   DRY                   default 0
 */
import pg from 'pg';
const { Pool } = pg;

const RAW = process.env.DATABASE_URL;
if (!RAW) { console.error('DATABASE_URL missing'); process.exit(1); }
const url = new URL(RAW);
if (url.hostname === 'postgres') url.hostname = '127.0.0.1';
const pool = new Pool({ connectionString: url.toString(), max: 4 });

const KEYS = (process.env.STUDIAI_API_KEYS || process.env.STUDIAI_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (!KEYS.length) { console.error('STUDIAI_API_KEYS missing'); process.exit(1); }
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL_HAIKU || 'claude-haiku-4-5';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const MAX_VIDEOS = Number(process.env.MAX_VIDEOS || 0);
const DRY = process.env.DRY === '1';

let keyIdx = 0;
function nextKey() { const k = KEYS[keyIdx % KEYS.length]; keyIdx++; return k; }

const SYSTEM_PROMPT = `Ești copywriter pentru un feed video tip TikTok pentru cumpărături.
Pentru fiecare produs primit, scrii O SINGURĂ propoziție scurtă în română (max 90 caractere),
captivantă, naturală, fără emoji exagerate, fără preț, fără hashtag-uri, fără "cumpără acum".
Tonul: prieten care recomandă ceva fain. Te uiți la titlu și la categorie ca să tragi esența.
NU repeta titlul. Adu un unghi: utilitate, problemă rezolvată, sezon, cui i se potrivește.
Răspunzi STRICT JSON: {"items":[{"id":"...","desc":"..."}]} — o intrare per produs primit, în ordine.`;

function makePrompt(items) {
  const lines = items.map(it =>
    `id=${it.id} | cat=${it.taxonomy_slug || '?'} | title=${it.title || ''}`
  ).join('\n');
  return `Generează descrieri pentru ${items.length} produse:\n${lines}`;
}

async function callStudiAI(messages, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const key = nextKey();
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: 2000,
          temperature: 0.7,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

function parseJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const obj = cleaned.match(/\{[\s\S]*\}/);
  if (obj) cleaned = obj[0];
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function processBatch(items) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: makePrompt(items) },
  ];
  const text = await callStudiAI(messages);
  const parsed = parseJSON(text);
  const out = [];
  const list = parsed?.items;
  if (!Array.isArray(list)) return out;
  for (const it of list) {
    if (!it?.id || !it?.desc) continue;
    let desc = String(it.desc).trim();
    if (desc.length > 140) desc = desc.slice(0, 137) + '...';
    out.push({ id: String(it.id), desc });
  }
  return out;
}

async function main() {
  const limitSql = MAX_VIDEOS > 0 ? ` LIMIT ${MAX_VIDEOS}` : '';
  const { rows } = await pool.query(
    `SELECT v.id::text AS id, v.title,
            (SELECT mp.taxonomy_node_slug FROM marketplace_products mp
              WHERE mp.id = (v.product_refs->0->>'product_id')::uuid LIMIT 1) AS taxonomy_slug
       FROM videos v
      WHERE v.status = 'ready'
        AND (v.description IS NULL OR v.description = '')
        AND v.title IS NOT NULL AND v.title <> ''
      ORDER BY v.published_at DESC NULLS LAST${limitSql}`
  );

  console.log(`[descriptions] mode=${DRY ? 'DRY' : 'APPLY'} model=${MODEL} batch=${BATCH_SIZE} keys=${KEYS.length} pending=${rows.length}`);
  if (!rows.length) { await pool.end(); return; }

  let done = 0, written = 0, failed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      const results = await processBatch(slice);
      if (!DRY) {
        for (const r of results) {
          await pool.query(
            `UPDATE videos SET description = $1, updated_at = NOW()
              WHERE id = $2 AND (description IS NULL OR description = '')`,
            [r.desc, r.id]
          );
          written++;
        }
      } else {
        for (const r of results.slice(0, 5)) {
          console.log(`  ${r.id.slice(0, 8)}: ${r.desc}`);
        }
        written += results.length;
      }
      done += slice.length;
      if (results.length < slice.length) failed += slice.length - results.length;
      const idx = Math.floor(i / BATCH_SIZE) + 1;
      const total = Math.ceil(rows.length / BATCH_SIZE);
      console.log(`[batch ${idx}/${total}] ok=${results.length}/${slice.length} cum=${done} written=${written} failed=${failed}`);
    } catch (e) {
      failed += slice.length;
      done += slice.length;
      console.error(`[batch error] ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[descriptions] done total=${done} written=${written} failed=${failed}`);
  await pool.end();
}

main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
