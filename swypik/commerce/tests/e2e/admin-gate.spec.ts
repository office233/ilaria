import { test, expect } from '@playwright/test';

test('/admin/users without auth redirects', async ({ request }) => {
  const res = await request.get('/admin/users', { maxRedirects: 0 });
  // Either 307 to /admin (login gate) or 302/303
  expect([301, 302, 303, 307, 308]).toContain(res.status());
  const loc = res.headers()['location'] ?? '';
  expect(loc).toMatch(/\/admin(\b|\/login|\/?$)/);
});

test('admin gate redirects to login destination', async ({ page }) => {
  // Follow redirect chain via page navigation
  await page.goto('/admin/users');
  // Final URL should be the admin login (/admin or /admin/login)
  await expect(page).toHaveURL(/\/admin(\/login)?(\?.*)?$/);
});
