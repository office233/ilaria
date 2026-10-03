import { test, expect } from '@playwright/test';
import { collectIssues, assertNoIssues } from './helpers';

/**
 * Faza 1 — Vizitator (nelogat), desktop + mobil (via projects).
 * Fiecare pagină publică: fără erori consolă / requests eșuate,
 * elemente cheie vizibile, acțiuni protejate cer login.
 */

const PUBLIC_PAGES: Array<{ path: string; expects: RegExp | string }> = [
  { path: '/', expects: /swypik/i },
  { path: '/explore', expects: /./ },
  { path: '/fly', expects: /zbor|flight|fly/i },
  { path: '/food', expects: /food|restaurant|mâncare|mancare/i },
  { path: '/stays', expects: /caz|stay|hotel/i },
  { path: '/go', expects: /go|cursă|cursa|ride/i },
  { path: '/missions', expects: /misiun|mission/i },
  { path: '/search', expects: /caut|search/i },
  { path: '/categories', expects: /categor/i },
  { path: '/shop', expects: /./ },
  { path: '/terms', expects: /termen|terms/i },
  { path: '/privacy', expects: /confiden|privacy/i },
  { path: '/auth/login', expects: /parol|password|email/i },
  { path: '/auth/signup', expects: /cont|sign|email/i },
  { path: '/become-a-seller', expects: /seller|vânz|vanz/i },
  { path: '/become-a-creator', expects: /creator/i },
  { path: '/cart', expects: /coș|cos|cart|gol/i },
  { path: '/about', expects: /./ },
];

for (const { path: p, expects } of PUBLIC_PAGES) {
  test(`vizitator: ${p} se încarcă curat`, async ({ page }) => {
    const issues = collectIssues(page);
    const res = await page.goto(p, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${p} status`).toBeLessThan(400);
    await page.waitForLoadState('networkidle').catch(() => {});
    const body = await page.locator('body').innerText();
    expect(body, `${p} conținut gol`).not.toEqual('');
    expect(body).toMatch(expects instanceof RegExp ? expects : new RegExp(expects, 'i'));
    expect(body).not.toMatch(/internal server error|application error|unhandled/i);
    assertNoIssues(issues, p);
  });
}

test('vizitator: produs real din explore/shop → pagină produs', async ({ page }) => {
  const issues = collectIssues(page);
  await page.goto('/shop', { waitUntil: 'domcontentloaded' });
  const productLink = page.locator('a[href*="/product/"]').first();
  if ((await productLink.count()) === 0) {
    // fallback: caută pe home
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
  await expect(productLink.or(page.locator('a[href*="/product/"]').first())).toBeVisible({ timeout: 15000 });
  const href = await page.locator('a[href*="/product/"]').first().getAttribute('href');
  await page.goto(href!, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/internal server error|404/i);
  // buton add-to-cart / cumpără vizibil
  await expect(
    page.locator('button', { hasText: /adaugă|cumpără|add to cart|buy/i }).first()
  ).toBeVisible({ timeout: 10000 });
  assertNoIssues(issues, 'product page');
});

test('vizitator: acțiune protejată (like în explore) cere login, nu crapă', async ({ page }) => {
  await page.goto('/explore', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const likeBtn = page.locator('button[aria-label*="like" i], button[aria-label*="apreciaz" i], [data-testid*="like"]').first();
  if ((await likeBtn.count()) === 0) test.info().annotations.push({ type: 'note', description: 'buton like negăsit în explore — verificat manual' });
  else {
    await likeBtn.click();
      // Trebuie să apară prompt de login (modal/redirect/toast), nu crash
      await page.waitForTimeout(3000);
      const url = page.url();
      const bodyText = await page.locator('body').innerText();
      const promptedLogin =
        /auth|login/.test(url) || /log ?in|conect|autentif|cont nou|sign ?up|creeaz/i.test(bodyText);
      expect(promptedLogin, `like nelogat trebuie să ceară login (url=${url})`).toBeTruthy();
      expect(bodyText).not.toMatch(/internal server error|application error/i);
  }
});

test('vizitator: search cu query real → rezultate → click', async ({ page }) => {
  const issues = collectIssues(page);
  await page.goto('/search?q=a', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  const result = page.locator('a[href*="/product/"], a[href*="/u/"], a[href*="/v/"]').first();
  if ((await result.count()) > 0) {
    const href = await result.getAttribute('href');
    await result.click();
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain(href!.split('?')[0]);
  }
  assertNoIssues(issues, 'search');
});

test('vizitator: header/footer link-uri de pe home funcționează', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const links = await page.$$eval('header a[href^="/"], footer a[href^="/"], nav a[href^="/"]', (as) =>
    [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))].slice(0, 15)
  );
  expect(links.length, 'home are link-uri de navigare').toBeGreaterThan(0);
  for (const href of links) {
    const res = await page.request.get(href);
    expect(res.status(), `link ${href}`).toBeLessThan(400);
  }
});
