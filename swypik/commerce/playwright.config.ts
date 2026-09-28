import { defineConfig, devices } from '@playwright/test';

/**
 * Ținta implicită e mediul LOCAL, nu producția.
 *
 * Până pe 2026-08-17, valoarea implicită era `https://swypik.com`: un
 * `npm run test:e2e` fără variabile de mediu lovea producția. Cele 10 spec-uri
 * din `tests/e2e` sunt read-only (a11y, seo, perf, homepage…), deci nu a produs
 * pagube — dar orice spec care scrie (checkout, upload, transfer SWYP) ar fi
 * creat date reale în `swypik_prod`. Există deja 20 de conturi `*@test.*`
 * suspendate în prod, urme ale unor rulări de test anterioare.
 *
 * Rularea împotriva producției rămâne posibilă — e folosită de workflow-ul
 * `e2e.yml` pentru smoke-testing — dar trebuie cerută explicit.
 */
const DEFAULT_BASE_URL = 'http://localhost:3000';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? DEFAULT_BASE_URL;

const PROD_HOSTS = /(^|\.)swypik\.com$/i;
let host = '';
try {
  host = new URL(baseURL).hostname;
} catch {
  throw new Error(
    `PLAYWRIGHT_BASE_URL nu e un URL valid: "${baseURL}"\n` +
    `Exemplu: PLAYWRIGHT_BASE_URL=http://localhost:3000`,
  );
}

if (PROD_HOSTS.test(host) && process.env.ALLOW_PROD_E2E !== '1') {
  throw new Error(
    [
      '',
      `Testele e2e ar rula împotriva PRODUCȚIEI (${baseURL}).`,
      '',
      'Dacă e intenționat (smoke-test read-only), setează:',
      '    ALLOW_PROD_E2E=1',
      '',
      'Altfel, pornește aplicația local și rulează:',
      '    PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:e2e',
      '',
      'Vezi tests/README.md pentru ce e necesar unui mediu de test complet.',
      '',
    ].join('\n'),
  );
}

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    extraHTTPHeaders: {
      'x-playwright-test': '1',
    },
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 430, height: 932 },
        // Force chromium engine (mobile chrome by default)
        browserName: 'chromium',
      },
      testDir: './tests/e2e',
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        browserName: 'chromium',
      },
      testDir: './tests/e2e',
    },
    /**
     * Suita completă (`tests/e2e-full`), adusă aici pe 2026-08-17 din propriul
     * `playwright.config.ts`, ca să existe o singură sursă de configurare.
     *
     * NU rulează în CI și nu e inclusă în `npm run test:e2e` implicit, pentru că
     * are nevoie de un mediu unde poate SCRIE: `helpers.ts:50` face signup real
     * (`apiSignup`), iar `03-user.spec.ts` parcurge fluxuri de utilizator
     * autentificat. Pe producție ar crea conturi reale.
     *
     * Se activează după ce există stack-ul de test:
     *     PLAYWRIGHT_BASE_URL=http://localhost:3000 \
     *       npx playwright test --project=full-desktop
     *
     * Timeout mai mare (45s) și fără paralelism: spec-urile depind unele de
     * altele prin sesiunile salvate în `artifacts/`.
     */
    {
      name: 'full-desktop',
      testDir: './tests/e2e-full',
      timeout: 45_000,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        browserName: 'chromium',
        trace: 'retain-on-failure',
        navigationTimeout: 25_000,
      },
    },
    {
      name: 'full-mobile',
      testDir: './tests/e2e-full',
      timeout: 45_000,
      fullyParallel: false,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        browserName: 'chromium',
        trace: 'retain-on-failure',
        navigationTimeout: 25_000,
      },
    },
  ],
});
