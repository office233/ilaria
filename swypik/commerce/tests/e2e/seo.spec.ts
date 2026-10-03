import { test, expect } from '@playwright/test';

test('sitemap.xml is served as XML', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const ct = res.headers()['content-type'] ?? '';
  expect(ct).toMatch(/xml/i);
  const body = await res.text();
  expect(body).toMatch(/<urlset|<sitemapindex/i);
});

test('robots.txt is served', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body.toLowerCase()).toContain('user-agent');
});
