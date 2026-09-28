#!/usr/bin/env node
// One-by-one plain-text translator via StudiAI OpenAI-compatible endpoint.
import fs from 'node:fs';
import path from 'node:path';

const LOCALE = process.argv[2];
if (!LOCALE) { console.error('locale required'); process.exit(1); }

const API_KEY = process.env.STUDIAI_API_KEY;
const BASE_URL = process.env.STUDIAI_BASE_URL || 'https://ai.studiai.ro/v1';
const MODEL = process.env.STUDIAI_MODEL || 'claude-haiku-4-5';
if (!API_KEY) { console.error('STUDIAI_API_KEY required'); process.exit(1); }
const API_URL = `${BASE_URL}/chat/completions`;

const ROOT = '/opt/swypik/app/messages';
const ro = JSON.parse(fs.readFileSync(path.join(ROOT, 'ro.json'), 'utf8'));
const target = JSON.parse(fs.readFileSync(path.join(ROOT, `${LOCALE}.json`), 'utf8'));

const LOC_NAMES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
const langName = LOC_NAMES[LOCALE] || LOCALE;

function walk(o, p = '', out = {}) {
  for (const k in o) {
    const key = p ? p + '.' + k : k;
    if (typeof o[k] === 'object' && o[k] !== null) walk(o[k], key, out);
    else out[key] = o[k];
  }
  return out;
}
function setPath(obj, p, v) {
  const parts = p.split('.');
  let n = obj;
  for (let i = 0; i < parts.length - 1; i++) { n[parts[i]] = n[parts[i]] || {}; n = n[parts[i]]; }
  n[parts[parts.length - 1]] = v;
}

const roFlat = walk(ro);
const targetFlat = walk(target);

const missing = [];
for (const k in roFlat) {
  const t = targetFlat[k];
  const r = roFlat[k];
  if (t === r && /[ăâîșțĂÂÎȘȚ]/.test(r || '')) missing.push(k);
}

console.log(`[${LOCALE}] ${missing.length} keys to translate (plain text, model=${MODEL})`);

async function translateOne(text) {
  const prompt = `Translate the following Romanian text to ${langName}. Return ONLY the translated text — no quotes, no JSON, no explanation, no prefix. Preserve email addresses, URLs, and parentheticals like (a), (b), (c), and adapt curly quotes appropriately for ${langName}.

Romanian:
${text}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text2 = data.choices?.[0]?.message?.content || '';
  return text2.trim().replace(/^["'„«]/, '').replace(/["'""»]$/, '').trim();
}

let ok = 0, fail = 0;
for (let i = 0; i < missing.length; i++) {
  const k = missing[i];
  process.stdout.write(`  [${i + 1}/${missing.length}] ${k} ... `);
  try {
    const translated = await translateOne(roFlat[k]);
    if (translated && translated !== roFlat[k]) {
      setPath(target, k, translated);
      ok++;
      console.log('OK (' + translated.slice(0, 50).replace(/\n/g, ' ') + (translated.length > 50 ? '...' : '') + ')');
    } else {
      fail++;
      console.log('EMPTY');
    }
  } catch (e) {
    fail++;
    console.log('ERR', String(e.message).slice(0, 120));
  }
  await new Promise(r => setTimeout(r, 250));
}

fs.writeFileSync(path.join(ROOT, `${LOCALE}.json`), JSON.stringify(target, null, 2) + '\n');
console.log(`[${LOCALE}] done — ok=${ok}, fail=${fail}`);
