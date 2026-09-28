import { test, expect } from '@playwright/test';

test('homepage loads with main nav', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status(), 'homepage status').toBeLessThan(400);

  // Title set by Next metadata
  await expect(page).toHaveTitle(/swypik/i);

  // Auth/login affordance somewhere on the page (link, button, or icon).
  // On the swipeable feed, login can be inside the user menu — accept any link to /auth/login.
  const loginLink = page.locator('a[href*="/auth/login"], a[href="/auth"], a[href*="/login"]').first();
  await expect(loginLink).toBeVisible({ timeout: 10_000 }).catch(async () => {
    // Fallback: at least an account/profile entry-point must exist
    const account = page.locator('a[href*="/account"], a[href*="/profile"], button:has-text("Login"), button:has-text("Sign in")').first();
    await expect(account).toBeVisible();
  });

  // No JS console error containing "Application error"
  const text = await page.content();
  expect(text).not.toMatch(/Application error: a (server-side|client-side) exception/i);
});
