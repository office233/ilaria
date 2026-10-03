import { test, expect } from '@playwright/test';

test('search page renders input and accepts query', async ({ page }) => {
  const response = await page.goto('/en/search');
  expect(response?.status(), '/search status').toBeLessThan(400);

  await expect(page.locator('h1').first()).toBeVisible();

  const input = page.locator('input#swypik-search, input[name="q"], input[type="search"]').first();
  await expect(input).toBeVisible();

  await input.fill('rochie');
  await input.press('Enter');

  // After submit either query string updates or page navigates — wait briefly
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });

  // Must not be a 5xx error page
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/500|internal server error|something went wrong/i);
});
