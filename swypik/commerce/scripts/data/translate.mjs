#!/usr/bin/env node
/**
 * Translates ae_categories.name_ro and ae_products.title_translations.ro
 * via Claude Opus 4.7 through GitHub Copilot Business API.
 *
 * Run on the VPS (token IP-locked to 46.224.197.2):
 *   node translate.mjs categories
 *   node translate.mjs products
 *   node translate.mjs placeholders
 */
import pg from 'pg';
import https from 'node:https';

const GH_PAT = process.env.GH_PAT;
const DB_URL = process.env.DATABASE_URL;
const MODEL = process.env.MODEL || 'claude-opus-4.7';
const BATCH = parseInt(process.env.BATCH || '25', 10);
const DRY = process.env.DRY === '1';

if (!GH_PAT || !DB_URL) { console.error('GH_PAT and DATABASE_URL required'); process.exit(1); }

const mode = process.argv[2];
if (!['categories', 'products', 'placeholders', 'count'].includes(mode)) {
  console.error('usage: translate.mjs <categories|products|placeholders|count>'); process.exit(1);
}

let copilotToken = null;
let copilotExpiresAt = 0;

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function getCopilotToken() {
  if (copilotToken && Date.now() / 1000 < copilotExpiresAt - 120) return copilotToken;
  const resp = await fetchJson('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      'Authorization': `token ${GH_PAT}`,
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot-chat/0.22.0',
      'User-Agent': 'GitHubCopilotChat/0.22.0',
    },
  });
  copilotToken = resp.token;
  copilotExpiresAt = resp.expires_at;
  console.log(`[token] refreshed, expires ${new Date(resp.expires_at * 1000).toISOString()}`);
  return copilotToken;
}

async function chat(systemMsg, userMsg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tok = await getCopilotToken();
      const resp = await fetchJson('https://api.business.githubcopilot.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tok}`,
          'Content-Type': 'application/json',
          'Editor-Version': 'vscode/1.95.0',
          'Copilot-Integration-Id': 'vscode-chat',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.2,
          max_tokens: 4000,
        }),
      });
      return resp.choices[0].message.content;
    } catch (e) {
      console.error(`[chat] attempt ${i+1} failed: ${e.message}`);
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function translateBatch(items, kind) {
  const sys = `You are a professional Romanian e-commerce translator. Translate fashion/product ${kind} from English to natural Romanian.
Rules:
- Use casual Romanian commerce language (like Bonprix.ro, Fashiondays.ro).
- Keep brand names untranslated.
- Be concise and natural - do NOT translate literally.
- Return STRICT JSON: {"items":[{"id":<id>,"ro":"<translation>"}]}.
- Output ONLY the JSON, no markdown fences, no commentary.`;
  const user = `Translate these ${items.length} ${kind} to Romanian:\n` +
    JSON.stringify(items.map(({id, text}) => ({id, en: text})));
  const out = await chat(sys, user);
  const cleaned = out.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response: ' + cleaned.slice(0, 200));
    parsed = JSON.parse(m[0]);
  }
  return parsed.items;
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

async function runCategories() {
  const { rows } = await client.query(
    `SELECT id, ae_category_id, name FROM ae_categories
     WHERE (name_ro IS NULL OR name_ro = '') AND name NOT LIKE 'Category %'
     ORDER BY id`
  );
  console.log(`[categories] ${rows.length} to translate`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const items = slice.map(r => ({ id: r.id, text: r.name }));
    try {
      const trans = await translateBatch(items, 'category names');
      const map = new Map(trans.map(t => [t.id, t.ro]));
      if (!DRY) {
        const updates = slice.map(r => map.has(r.id) ? client.query(
          'UPDATE ae_categories SET name_ro = $1 WHERE id = $2',
          [map.get(r.id), r.id]
        ) : null).filter(Boolean);
        await Promise.all(updates);
      }
      console.log(`[categories] ${i + slice.length}/${rows.length} done (${trans.length} translated)`);
    } catch (e) {
      console.error(`[categories] batch ${i} failed: ${e.message}`);
    }
  }
}

async function runProducts() {
  const { rows } = await client.query(
    `SELECT id, title FROM ae_products
     WHERE title_translations IS NULL OR (title_translations->>'ro') IS NULL OR (title_translations->>'ro') = ''
     ORDER BY id`
  );
  console.log(`[products] ${rows.length} to translate`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const items = slice.map(r => ({ id: r.id, text: r.title.slice(0, 250) }));
    try {
      const trans = await translateBatch(items, 'product titles');
      const map = new Map(trans.map(t => [t.id, t.ro]));
      if (!DRY) {
        const updates = slice.map(r => map.has(r.id) ? client.query(
          `UPDATE ae_products
           SET title_translations = COALESCE(title_translations, '{}'::jsonb)
             || jsonb_build_object('en', title, 'ro', $1::text)
           WHERE id = $2`,
          [map.get(r.id), r.id]
        ) : null).filter(Boolean);
        await Promise.all(updates);
      }
      console.log(`[products] ${i + slice.length}/${rows.length} done`);
    } catch (e) {
      console.error(`[products] batch ${i} failed: ${e.message}`);
    }
  }
}

async function runPlaceholders() {
  const { rows } = await client.query(
    `SELECT c.id, c.ae_category_id, c.parent_id,
            (SELECT name FROM ae_categories pc WHERE pc.ae_category_id = c.parent_id) AS parent_name,
            (SELECT array_agg(LEFT(p.title, 100)) FROM (
              SELECT title FROM ae_products WHERE category_id = c.ae_category_id LIMIT 5
            ) p) AS sample_titles
     FROM ae_categories c
     WHERE c.name LIKE 'Category %'
     ORDER BY c.id`
  );
  console.log(`[placeholders] ${rows.length} to resolve`);
  for (const r of rows) {
    const samples = (r.sample_titles || []).join('\n- ');
    const sys = `You are a product taxonomist. Given product titles in a category, infer the most likely English category name (2-3 words, plural form, like "Phone Cases", "Walkie Talkies", "Hair Accessories"). Then provide the Romanian translation. Output STRICT JSON: {"en":"<name>","ro":"<numele>"}. No markdown, no commentary.`;
    const user = `Parent category: ${r.parent_name || 'unknown'}\nProducts in this category:\n- ${samples}`;
    try {
      const out = await chat(sys, user);
      const cleaned = out.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned.match(/\{[\s\S]*\}/)[0]);
      console.log(`[placeholder] ${r.ae_category_id}: ${parsed.en} / ${parsed.ro}`);
      if (!DRY) {
        await client.query(
          'UPDATE ae_categories SET name = $1, name_ro = $2 WHERE id = $3',
          [parsed.en, parsed.ro, r.id]
        );
      }
    } catch (e) {
      console.error(`[placeholder] ${r.ae_category_id} failed: ${e.message}`);
    }
  }
}

async function runCount() {
  const cats = await client.query(`SELECT COUNT(*) FROM ae_categories WHERE name_ro IS NULL OR name_ro = ''`);
  const prods = await client.query(`SELECT COUNT(*) FROM ae_products WHERE title_translations IS NULL OR (title_translations->>'ro') IS NULL OR (title_translations->>'ro') = ''`);
  const phs = await client.query(`SELECT COUNT(*) FROM ae_categories WHERE name LIKE 'Category %'`);
  console.log(`Categories missing name_ro: ${cats.rows[0].count}`);
  console.log(`Products missing title_translations.ro: ${prods.rows[0].count}`);
  console.log(`Placeholder categories: ${phs.rows[0].count}`);
}

if (mode === 'categories') await runCategories();
else if (mode === 'products') await runProducts();
else if (mode === 'placeholders') await runPlaceholders();
else if (mode === 'count') await runCount();

await client.end();
console.log('Done.');
