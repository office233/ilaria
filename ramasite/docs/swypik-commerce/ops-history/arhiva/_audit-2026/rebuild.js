const fs = require('fs');
const path = require('path');

const WF = 'C:/Users/Pos5/.claude/projects/E--Swypik/a7ce0c38-1b40-4b6d-abcc-44efa579c3f7/subagents/workflows/';
const OUT = 'C:/Users/Pos5/AppData/Local/Temp/claude/E--Swypik/a7ce0c38-1b40-4b6d-abcc-44efa579c3f7/scratchpad/';
fs.mkdirSync(OUT, { recursive: true });

function readJournal(run) {
  const p = WF + run + '/journal.jsonl';
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function norm(p) {
  let s = String(p || '').split('\\').join('/');
  const i = s.toLowerCase().indexOf('swypik/app/');
  if (i >= 0) s = s.slice(i + 'swypik/app/'.length);
  return s.replace(/^\/+/, '');
}

// --- constatari din cele doua batch-uri de audit ---
const audits = [
  { run: 'wf_8ad204c3-f3e', batch: 1 },
  { run: 'wf_7266b8b5-2b6', batch: 2 },
];

let all = [];
for (const a of audits) {
  const recs = readJournal(a.run).filter(o => o.type === 'result' && o.result && Array.isArray(o.result.findings));
  let n = 0;
  for (const r of recs) {
    for (const f of r.result.findings) {
      all.push(Object.assign({}, f, { file: norm(f.file), slice: f.slice || r.key || '?', batch: a.batch }));
      n++;
    }
  }
  console.log('batch ' + a.batch + ' (' + a.run + '): ' + recs.length + ' felii, ' + n + ' constatari');
}

// dedup pe fisier:linie
const seen = new Map();
for (const f of all) {
  const k = f.file + ':' + f.line;
  if (!seen.has(k)) seen.set(k, Object.assign({}, f, { dupes: [] }));
  else seen.get(k).dupes.push(f.slice);
}
const dedup = [...seen.values()];
console.log('\nTOTAL brut: ' + all.length + '  ->  unice dupa fisier:linie: ' + dedup.length);

const sev = {}, cat = {};
for (const f of dedup) {
  sev[f.severity] = (sev[f.severity] || 0) + 1;
  cat[f.category] = (cat[f.category] || 0) + 1;
}
console.log('severitate:', JSON.stringify(sev));
console.log('categorie :', JSON.stringify(cat));

fs.writeFileSync(OUT + 'findings-all.json', JSON.stringify(dedup, null, 1));

// --- criticals, fara cele 5 deja reparate de mine ---
const FIXED = new Set([
  'app/api/admin/orders/[id]/fraud-decision/route.ts:23',
  'app/api/admin/users/[id]/fraud-block/route.ts:15',
  'app/api/admin/orders/risk/route.ts:51',
  'app/api/listings/route.ts:192',
  'app/api/listings/route.ts:168',
  'lib/social/proxy.ts:26',
]);

const crit = dedup
  .filter(f => f.severity === 'critical')
  .filter(f => !FIXED.has(f.file + ':' + f.line))
  .map((f, i) => ({
    idx: i, slice: f.slice, alsoFoundBy: f.dupes || [], title: f.title,
    category: f.category, file: f.file, line: f.line,
    evidence: f.evidence, failure: f.failure, fix: f.fix,
  }));

fs.writeFileSync(OUT + 'criticals.json', JSON.stringify(crit, null, 1));
console.log('\ncritice de verificat: ' + crit.length + ' (excluse cele deja reparate)');

// --- verdicte deja obtinute inainte de oprire ---
const vrecs = readJournal('wf_31690058-b40').filter(o => o.type === 'result' && o.result && typeof o.result.real === 'boolean');
console.log('verdicte recuperate din rularea oprita: ' + vrecs.length + ' (pe indexarea VECHE — se reverifica)');
