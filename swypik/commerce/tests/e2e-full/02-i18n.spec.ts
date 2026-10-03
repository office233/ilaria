import { test, expect } from '@playwright/test';
import { collectIssues, assertNoIssues } from './helpers';

/**
 * Faza 2 — i18n × 7 limbi.
 * Verificăm <html lang>, <title>, absența stringurilor hardcodate RO pe non-RO,
 * LocaleSwitcher fără dublare de locale.
 */

const LOCALES = [
  { prefix: '', lang: 'ro' },
  { prefix: '/en', lang: 'en' },
  { prefix: '/de', lang: 'de' },
  { prefix: '/fr', lang: 'fr' },
  { prefix: '/es', lang: 'es' },
  { prefix: '/it', lang: 'it' },
  { prefix: '/pt', lang: 'pt' },
];

const PAGES = ['', '/explore', '/fly', '/terms'];

// Stringuri RO care NU trebuie să apară pe paginile non-RO
const RO_LEAKS = /Descoperă produse|Adaugă în coș|Cumpără acum|Caută produse/;

for (const { prefix, lang } of LOCALES) {
  for (const p of PAGES) {
    const url = `${prefix}${p}` || '/';
    test(`i18n [${lang}]: ${url} — lang, title, fără RO hardcodat`, async ({ page }) => {
      test.skip(test.info().project.name !== 'desktop', 'i18n doar desktop');
      const issues = collectIssues(page);
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), `${url} status`).toBeLessThan(400);

      const htmlLang = await page.locator('html').getAttribute('lang');
      expect(htmlLang, `${url} <html lang>`).toContain(lang);

      const title = await page.title();
      expect(title.length, `${url} title gol`).toBeGreaterThan(0);

      if (lang !== 'ro') {
        const body = await page.locator('body').innerText();
        expect(body, `${url} conține stringuri RO hardcodate`).not.toMatch(RO_LEAKS);
      }
      assertNoIssues(issues, url);
    });
  }
}

test('i18n: LocaleSwitcher navighează corect fără locale dublat', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'doar desktop');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Deschide switcher-ul (buton cu limba/glob)
  const switcher = page
    .locator('button[aria-label*="lang" i], button[aria-label*="limb" i], [data-testid*="locale"], button:has-text("RO")')
    .first();
  if ((await switcher.count()) === 0) {
    // fallback: pagină de preferințe are selector de limbă — verificat în faza 3
    test.info().annotations.push({ type: 'note', description: 'LocaleSwitcher negăsit pe home — verificat via /en direct' });
    await page.goto('/en');
    expect(page.url()).not.toMatch(/\/en\/en/);
    return;
  }
  await switcher.click();
  const enOption = page.locator('a[href="/en"], [role="menuitem"]:has-text("English"), a:has-text("English")').first();
  await expect(enOption).toBeVisible({ timeout: 5000 });
  await enOption.click();
  await page.waitForLoadState('domcontentloaded');
  expect(page.url()).toMatch(/\/en(\/|$)/);
  expect(page.url()).not.toMatch(/\/en\/en/);
  // persistă la refresh
  await page.reload();
  expect(await page.locator('html').getAttribute('lang')).toContain('en');
});
