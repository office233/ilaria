/**
 * Forms autocomplete regression guard.
 * Verifică WCAG 1.3.5 (Identify Input Purpose) — input-urile critice
 * (email/tel/organization/etc.) trebuie să aibă atribut autocomplete
 * corect pentru a permite browser autofill și a îmbunătăți UX.
 */
import { test, expect, devices } from '@playwright/test';

const BASE = process.env.BASE_URL || 'https://swypik.com';

async function gotoFormPage(page: import('@playwright/test').Page, path: string) {
  const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
  expect(resp?.ok(), `HTTP OK for ${path}`).toBe(true);
  await page.locator('body').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  return resp;
}

interface ExpectedField {
  selector: string;
  autocomplete: string;
  inputMode?: string;
}

interface FormPage {
  name: string;
  path: string;
  fields: ExpectedField[];
}

const FORMS: FormPage[] = [
  {
    name: 'become-a-seller',
    path: '/become-a-seller',
    fields: [
      { selector: 'input#companyName', autocomplete: 'organization' },
      { selector: 'input#email', autocomplete: 'email', inputMode: 'email' },
      { selector: 'input#phone', autocomplete: 'tel', inputMode: 'tel' },
    ],
  },
];

for (const form of FORMS) {
  test(`forms autocomplete: ${form.name} has correct tokens`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await gotoFormPage(page, form.path);

    for (const f of form.fields) {
      const el = page.locator(f.selector).first();
      await expect(el, `${f.selector} exists`).toBeVisible();
      const ac = await el.getAttribute('autocomplete');
      expect(ac, `${f.selector} autocomplete`).toBe(f.autocomplete);
      if (f.inputMode) {
        const im = await el.getAttribute('inputmode');
        expect(im, `${f.selector} inputmode`).toBe(f.inputMode);
      }
    }

    await ctx.close();
  });
}

/**
 * Smoke: orice input[type=email] / input[type=tel] din pagini publice cheie
 * trebuie să aibă autocomplete attr (best-effort scan).
 */
const SMOKE_PAGES = ['/auth/login', '/auth/signup', '/auth/forgot', '/become-a-seller'];

for (const p of SMOKE_PAGES) {
  test(`forms autocomplete smoke: ${p} email/tel inputs have autocomplete`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await gotoFormPage(page, p);

    const missing = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="email"], input[type="tel"]'));
      return inputs
        .filter(i => !i.getAttribute('autocomplete'))
        .map(i => ({ type: i.getAttribute('type'), name: i.getAttribute('name'), id: i.id }));
    });
    expect(missing, `${p} inputs missing autocomplete`).toEqual([]);
    await ctx.close();
  });
}
