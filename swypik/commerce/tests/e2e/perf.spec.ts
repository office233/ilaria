import { test, expect, devices } from '@playwright/test';

const BASE = process.env.BASE_URL || 'https://swypik.com';

test.describe.configure({ retries: 2, mode: 'serial' });

/**
 * Perf budget guards — fail dacă pagina cheie crește semnificativ.
 * Budget-urile sunt headroom 50%+ peste baseline observat (2026-05-28)
 * pentru a tolera variance rețea / cold cache. Scop: prinde regressions
 * majore (ex: imagini neoptimizate adăugate accidental), nu micro-fluctuații.
 */
const BUDGETS = [
  { path: '/', maxImgKB: 2000, maxLoadMs: 8000 },
  { path: '/explore', maxImgKB: 2000, maxLoadMs: 12000 },
];

for (const b of BUDGETS) {
  test(`perf budget: ${b.path} stays under ${b.maxImgKB}KB images / ${b.maxLoadMs}ms load`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    let imgBytes = 0;
    page.on('response', (resp) => {
      const ct = resp.headers()['content-type'] || '';
      if (ct.startsWith('image/')) {
        imgBytes += Number(resp.headers()['content-length'] || 0);
      }
    });
    const t0 = Date.now();
    const resp = await page.goto(BASE + b.path, { waitUntil: 'load', timeout: 30000 });
    const loadMs = Date.now() - t0;
    expect(resp?.ok(), `HTTP OK for ${b.path}`).toBe(true);
    const imgKB = Math.round(imgBytes / 1024);
    console.log(`[perf] ${b.path}: load=${loadMs}ms imgKB=${imgKB}`);
    expect(imgKB, `${b.path} image budget`).toBeLessThanOrEqual(b.maxImgKB);
    expect(loadMs, `${b.path} load time`).toBeLessThanOrEqual(b.maxLoadMs);
    await ctx.close();
  });
}
