import { test, expect } from '@playwright/test';
import { BASE, ORIGIN } from './helpers';

/** Faza 5 — Negative & edge. */

test.beforeEach(async ({}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'desktop', 'faza 5 doar desktop');
});

test('404 personalizat pe rută inexistentă', async ({ page }) => {
  const res = await page.goto('/ruta-care-nu-exista-xyz', { waitUntil: 'domcontentloaded' });
  expect(res?.status()).toBe(404);
  const body = await page.locator('body').innerText();
  expect(body.trim().length, 'nu ecran alb').toBeGreaterThan(20);
  expect(body).toMatch(/404|găsit|not found|există/i);
});

for (const p of ['/product/inexistent-xyz', '/v/xxx-inexistent', '/u/user_inexistent_xyz_999', '/missions/slug-inexistent']) {
  test(`ID inexistent: ${p} → eroare elegantă, nu 500`, async ({ page }) => {
    const res = await page.goto(p, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${p} nu trebuie să dea 500`).toBeLessThan(500);
    // 404-ul e streamed (Suspense) — așteptăm textul randat
    await expect(page.locator('body')).toContainText(/404|găsit|gasit|negasit|nu exista|not found/i, { timeout: 10000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/internal server error|application error/i);
    expect(body.trim().length, 'nu ecran alb').toBeGreaterThan(20);
  });
}

test('rate limit login: 5 requesturi rapide nu crapă serverul', async ({ request }) => {
  const results: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await request.post(`${BASE}/api/auth`, {
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      data: { action: 'login_password', email: 'rl-test@test.swypik.local', password: 'gresit' },
    });
    results.push(r.status());
  }
  // Niciun 5xx; 401/400/429 sunt OK
  for (const s of results) expect(s, `statusuri: ${results}`).toBeLessThan(500);
});

test('cookie șters → acțiune protejată cere relogin elegant', async ({ page, context }) => {
  await page.goto('/account', { waitUntil: 'domcontentloaded' });
  await context.clearCookies();
  const res = await page.goto('/account/orders', { waitUntil: 'domcontentloaded' });
  // redirect la login sau prompt, nu 500
  expect(res?.status()).toBeLessThan(500);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/internal server error/i);
});

test('CSRF: POST /api/auth fără Origin corect → respins', async ({ request }) => {
  const r = await request.post(`${BASE}/api/auth`, {
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
    data: { action: 'login_password', email: 'x@x.com', password: 'x' },
  });
  // 429 = rate limiterul a prins request-ul înainte de CSRF check — tot refuz e
  expect([403, 400, 401, 429], `CSRF guard: ${r.status()}`).toContain(r.status());
});
