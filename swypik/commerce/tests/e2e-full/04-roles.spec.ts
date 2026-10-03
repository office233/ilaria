import { test, expect } from '@playwright/test';
import { collectIssues, assertNoIssues, testEmail, apiSignup, uiLogin } from './helpers';

/**
 * Faza 4 — Roluri privilegiate.
 * - user normal: /admin + /seller refuzate, /api/admin/* 401/403/404
 * - seller: sesiune injectată în DB (cookie seller_session) — token setat prin env E2E_SELLER_TOKEN
 * - admin: login cu ADMIN_SECRET prin env E2E_ADMIN_SECRET (POST /api/admin/login)
 */

test.beforeEach(async ({}, testInfo) => {
  testInfo.skip(testInfo.project.name !== 'desktop', 'faza 4 doar desktop');
});

test('user normal: /admin refuzat + /api/admin/* 401/403/404', async ({ page, request }) => {
  test.setTimeout(120_000);
  const email = testEmail('_f4');
  const res = await apiSignup(request, email);
  expect(res.ok(), `signup: ${res.status()}`).toBeTruthy();
  await uiLogin(page, email);

  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').innerText();
  // fără dashboard: ori formular de parolă admin, ori refuz
  expect(body).not.toMatch(/Utilizatori.*Comenzi platform/s);

  for (const api of ['/api/admin/users', '/api/admin/orders', '/api/admin/sellers']) {
    const r = await page.request.get(api);
    expect([401, 403, 404], `${api} → ${r.status()}`).toContain(r.status());
  }

  // Link admin ascuns în UI
  await page.goto('/account');
  const adminLink = page.locator('a[href*="/admin"]');
  expect(await adminLink.count(), 'link admin vizibil pt user normal').toBe(0);

  // Seller dashboard refuzat
  await page.goto('/seller/orders', { waitUntil: 'domcontentloaded' }).catch(() => {});
  expect(page.url(), 'seller/orders trebuie să redirecteze la login seller').toMatch(/seller\/login|auth|login/);
});

const SELLER_TOKEN = process.env.E2E_SELLER_TOKEN;

test('seller: dashboard + secțiuni se deschid', async ({ page }) => {
  test.skip(!SELLER_TOKEN, 'E2E_SELLER_TOKEN nesetat — vezi NETESTABIL/raport');
  test.setTimeout(180_000);
  await page.context().addCookies([
    { name: 'seller_session', value: SELLER_TOKEN!, domain: 'swypik.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' },
  ]);
  for (const p of ['/seller', '/seller/products', '/seller/orders', '/seller/payouts', '/seller/listings', '/seller/returns', '/seller/settings', '/seller/merchant', '/seller/cazari']) {
    const issues = collectIssues(page);
    const res = await page.goto(p, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${p}`).toBeLessThan(400);
    expect(page.url(), `${p} nu trebuie să redirecteze la login`).not.toMatch(/seller\/login/);
    const body = await page.locator('body').innerText();
    expect(body, p).not.toMatch(/internal server error/i);
    assertNoIssues(issues, p);
  }
});

// Acces de urgență: necesită ADMIN_BREAK_GLASS_ENABLED=1 pe server + emailul unui admin.
const ADMIN_SECRET = process.env.E2E_ADMIN_SECRET;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;

const ADMIN_SECTIONS = [
  '/admin', '/admin/users', '/admin/orders', '/admin/sellers', '/admin/videos',
  '/admin/moderation', '/admin/payouts', '/admin/refunds', '/admin/returns',
  '/admin/reviews', '/admin/risk', '/admin/marketplace', '/admin/creators',
  '/admin/commissions', '/admin/disputes', '/admin/health', '/admin/pricing',
  '/admin/applications', '/admin/strikes', '/admin/fleet', '/admin/hosts', '/admin/cron',
];

test('admin: fiecare secțiune se deschide și se populează', async ({ page }) => {
  test.skip(!ADMIN_SECRET || !ADMIN_EMAIL, 'E2E_ADMIN_SECRET/E2E_ADMIN_EMAIL nesetate — vezi NETESTABIL/raport');
  test.setTimeout(300_000);
  // login admin de urgență: POST /api/admin/login cu secretul + emailul adminului
  const login = await page.request.post('https://swypik.com/api/admin/login', {
    headers: { Origin: 'https://swypik.com', 'Content-Type': 'application/json' },
    data: { email: ADMIN_EMAIL, password: ADMIN_SECRET },
  });
  expect(login.ok(), `admin login: ${login.status()}`).toBeTruthy();

  for (const p of ADMIN_SECTIONS) {
    const issues = collectIssues(page);
    const res = await page.goto(p, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${p}`).toBeLessThan(400);
    const body = await page.locator('body').innerText();
    expect(body, p).not.toMatch(/internal server error/i);
    expect(body.trim().length, `${p} pagină goală`).toBeGreaterThan(50);
    assertNoIssues(issues, p);
  }
});
