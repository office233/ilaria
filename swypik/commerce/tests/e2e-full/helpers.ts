import { Page, expect, APIRequestContext } from '@playwright/test';

export const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'https://swypik.com';
export const ORIGIN = BASE;

export type PageIssues = {
  consoleErrors: string[];
  failedRequests: string[];
};

/** Attach console + failed-request collectors to a page. Call BEFORE navigation. */
export function collectIssues(page: Page): PageIssues {
  const issues: PageIssues = { consoleErrors: [], failedRequests: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore known benign noise (3rd-party, favicon, aborted media)
      if (/favicon|ERR_ABORTED|net::ERR_FAILED.*(hls|\.m3u8|\.ts\b)/i.test(text)) return;
      // fetch anulat de navigare (unmount) — nu e bug de aplicație
      if (/TypeError: Failed to fetch/.test(text)) return;
        // 401 pe check-uri best-effort de sesiune când ești nelogat = comportament așteptat
        const locUrl = msg.location()?.url ?? '';
        if (/status of 401/.test(text) && /\/api\/(auth|me|session)/.test(locUrl)) return;
      issues.consoleErrors.push(text.slice(0, 300));
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400 && url.startsWith(BASE)) {
      // Expected 401s on auth-check endpoints when logged out
        if (res.status() === 401 && /\/api\/(auth|me|session)/.test(url)) return;
      issues.failedRequests.push(`${res.status()} ${url.slice(0, 200)}`);
    }
  });
  return issues;
}

export function assertNoIssues(issues: PageIssues, context: string) {
  expect(issues.consoleErrors, `${context}: console errors`).toEqual([]);
  expect(issues.failedRequests, `${context}: failed requests`).toEqual([]);
}

export function testEmail(tag = '') {
  return `e2e_pw_${Date.now()}${tag}@test.swypik.local`;
}

export const TEST_PASSWORD = 'E2ePw!Test12345';

/** Create a user via the auth API (fast path for phases that don't test the signup UI itself). */
export async function apiSignup(request: APIRequestContext, email: string, username?: string) {
  const res = await request.post(`${BASE}/api/auth`, {
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    data: {
      action: 'signup_password',
      email,
      password: TEST_PASSWORD,
      username: username ?? `e2e_pw_${Date.now().toString(36)}`,
      first_name: 'E2E',
      last_name: 'Tester',
    },
  });
  return res;
}

export async function apiLogin(request: APIRequestContext, email: string, password = TEST_PASSWORD) {
  return request.post(`${BASE}/api/auth`, {
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    data: { action: 'login_password', email, password },
  });
}

/** Închide bannerul GDPR dacă blochează UI-ul. */
export async function dismissCookies(page: Page) {
  const btn = page.getByRole('button', { name: /accept all|essential only|doar esențiale|accept/i }).first();
  if ((await btn.count()) > 0) await btn.click({ timeout: 3000 }).catch(() => {});
}

/** Închide dialogurile de onboarding/welcome care acoperă pagina. */
export async function dismissOverlays(page: Page) {
  await dismissCookies(page);
  // dialogul de onboarding poate apărea cu întârziere
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) {
    const close = page.getByRole('dialog').getByRole('button', { name: /închide|close|✕|×/i }).first();
    if ((await close.count()) === 0) break;
    await close.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

/** UI login through /auth/login form. */
export async function uiLogin(page: Page, email: string, password = TEST_PASSWORD) {
  // Reuse sesiunea salvată pentru același email (evită rate limitul de login)
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const stateFile = path.resolve(__dirname, `artifacts/session-${email.replace(/[^a-z0-9]/gi, '_')}.json`);
  if (fs.existsSync(stateFile)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      await page.context().addCookies(cookies);
      await page.goto('/account', { waitUntil: 'domcontentloaded' });
      if (!/auth|login/.test(page.url())) return; // sesiune validă
    } catch { /* fallthrough la login normal */ }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto('/auth/login');
    await dismissCookies(page);
    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    try {
      await page.waitForURL((u) => !/\/auth\/login/.test(u.toString()), { timeout: 15_000 });
      // marchez onboarding-ul complet ca modalul să nu mai intercepteze clickurile
      await page.request.post(`${BASE}/api/users/me/onboarding/complete`, { headers: { Origin: ORIGIN } }).catch(() => {});
      // salvez cookie-urile pentru refolosire
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(await page.context().cookies()));
      } catch { /* non-fatal */ }
      return;
    } catch {
      // posibil rate limit — așteaptă și reîncearcă
      await page.waitForTimeout(20_000);
    }
  }
  throw new Error(`uiLogin failed for ${email} after 3 attempts`);
}

/** Login and transfer session cookies from API context into browser context. */
export async function loginViaApi(page: Page, email: string, password = TEST_PASSWORD) {
  const res = await apiLogin(page.request, email, password);
  expect(res.ok(), `api login for ${email}: ${res.status()}`).toBeTruthy();
}
