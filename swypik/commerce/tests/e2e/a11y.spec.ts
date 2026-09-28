import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Smoke a11y regression test: rulează în post-deploy hook din safe-deploy-web.sh.
// Scop: prinde regresii MAJORE pe top pages (serious + critical). Nu blochează deploy
// pentru issues moderate (BottomNav etc), doar la nivel serious/critical pe pagini critice.

// Retries: tolerează flakiness post-deploy (cold container, paralelism cu alte spec-uri).
test.describe.configure({ retries: 2 });

const PAGES = [
  { name: 'home', url: '/' },
  { name: 'explore', url: '/explore' },
  { name: 'product-list', url: '/categorii' },
  { name: 'help', url: '/help' },
];

for (const p of PAGES) {
  test(`a11y smoke: ${p.name} has no serious/critical violations`, async ({ page }) => {
    const resp = await page.goto(p.url, { waitUntil: 'networkidle', timeout: 30000 });
    expect(resp?.status(), `HTTP for ${p.url}`).toBeLessThan(400);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    if (blocking.length > 0) {
      console.error(`\n[a11y/${p.name}] ${blocking.length} blocking violations:`);
      for (const v of blocking) {
        console.error(`  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
        console.error(`    ${v.helpUrl}`);
      }
    }
    expect(blocking, `${p.name}: serious/critical a11y violations`).toEqual([]);
  });
}

test('a11y: skip-to-content link exists and is focusable', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const skip = page.locator('a[href="#main-content"]').first();
  await expect(skip, 'skip link present').toBeAttached();
  // Focus via keyboard (Tab from body)
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  expect(focused, 'first Tab focuses skip link').toBe('#main-content');
});

test('a11y: <main> landmark present on key pages', async ({ page }) => {
  for (const url of ['/', '/explore', '/cart', '/help']) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const mainCount = await page.locator('main, [role="main"], #main-content').count();
    expect(mainCount, `${url} has main landmark`).toBeGreaterThan(0);
  }
});

test('a11y: global :focus-visible outline applied', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Verify CSS rule exists (sanity check that globals.css picked up)
  const hasFocusRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          if (rule instanceof CSSStyleRule && rule.selectorText?.includes(':focus-visible')) {
            return true;
          }
        }
      } catch { /* cross-origin */ }
    }
    return false;
  });
  expect(hasFocusRule, 'global :focus-visible rule present').toBe(true);
});
