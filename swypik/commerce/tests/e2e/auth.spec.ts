import { test, expect } from '@playwright/test';

test('login page shows form and rejects bad credentials', async ({ page }) => {
  const response = await page.goto('/auth/login');
  expect(response?.status(), '/auth/login status').toBeLessThan(400);

  await expect(page.locator('form').first()).toBeVisible();

  const email = page.locator('input[type="email"], input[name="email"]').first();
  const password = page.locator('input[type="password"], input[name="password"]').first();
  await expect(email).toBeVisible();
  await expect(password).toBeVisible();

  await email.fill(`playwright-smoke+${Date.now()}@example.invalid`);
  await password.fill('definitely-not-a-real-password-xyz');

  const submit = page.locator('button[type="submit"]').first();
  await submit.click();

  // App must respond with an error UI rather than crashing
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/internal server error|application error/i);
  // Still on login page (no successful redirect to /account or /)
  await expect(page).toHaveURL(/\/auth\/login/);
});
