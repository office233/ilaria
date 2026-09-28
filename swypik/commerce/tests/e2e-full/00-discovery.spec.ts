import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { BASE } from './helpers';

/**
 * Faza 0 — Descoperire automată.
 * Crawl de la / (max 3 niveluri), colectăm <a href> interne,
 * verificăm status pentru fiecare link găsit → link-uri MOARTE.
 * Comparăm cu inventarul static (tests/route-inventory-pages.txt) → rute ORFANE.
 */

const MAX_DEPTH = 3;
const MAX_PAGES = 120;

test.describe.configure({ mode: 'serial' });

test('crawl: link-uri interne, morți și orfane', async ({ page, request }) => {
  test.setTimeout(600_000);
  test.skip(test.info().project.name !== 'desktop', 'crawl doar pe desktop');

  const visited = new Map<string, number>(); // path -> status
  const queue: Array<{ url: string; depth: number }> = [{ url: '/', depth: 0 }];
  const found = new Set<string>(['/']);

  while (queue.length && visited.size < MAX_PAGES) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    let status = 0;
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      status = res?.status() ?? 0;
    } catch {
      status = -1;
    }
    visited.set(url, status);
    if (status >= 400 || status <= 0 || depth >= MAX_DEPTH) continue;

    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') || ''));
    for (let h of hrefs) {
      if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:')) continue;
      if (h.startsWith('http')) {
        if (!h.startsWith(BASE)) continue;
        h = h.slice(BASE.length) || '/';
      }
      h = h.split('#')[0].split('?')[0];
      if (!h.startsWith('/')) continue;
      if (!found.has(h)) {
        found.add(h);
        queue.push({ url: h, depth: depth + 1 });
      }
    }
  }

  // Link-uri rămase în coadă (peste MAX_PAGES) — verificate doar cu HEAD/GET rapid
  for (const { url } of queue.slice(0, 100)) {
    if (visited.has(url)) continue;
    try {
      const res = await request.get(BASE + url, { maxRedirects: 5 });
      visited.set(url, res.status());
    } catch {
      visited.set(url, -1);
    }
  }

  const dead = [...visited.entries()].filter(([, s]) => s >= 500 || s === -1);
  const notFound = [...visited.entries()].filter(([, s]) => s === 404);

  // Rute orfane: în inventar static dar negăsite de crawl (exclude dinamice/protejate)
  const invPath = path.resolve(__dirname, '../route-inventory-pages.txt');
  const inv = fs
    .readFileSync(invPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\uFEFF/, ''))
    .filter(Boolean)
    .filter((r) => !r.includes('[') && !r.includes('(') && !r.startsWith('/admin') && !r.startsWith('/seller') && !r.startsWith('/courier'));
  const crawledPaths = new Set([...found].map((p) => p.replace(/^\/(en|de|fr|es|it|pt)(\/|$)/, '/').replace(/\/$/, '') || '/'));
  const orphans = inv
    .map((r) => r.replace('/[locale]', '') || '/')
    .filter((r) => !crawledPaths.has(r));

  const report = {
    crawled: visited.size,
    dead: Object.fromEntries(dead),
    notFound: Object.fromEntries(notFound),
    orphans,
  };
  fs.mkdirSync(path.resolve(__dirname, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, 'artifacts/discovery-report.json'), JSON.stringify(report, null, 2));
  console.log('DISCOVERY:', JSON.stringify(report, null, 2));

  expect(dead, 'link-uri cu 500/erori de rețea').toEqual([]);
  expect(notFound, 'link-uri moarte (404) legate din UI').toEqual([]);
});
