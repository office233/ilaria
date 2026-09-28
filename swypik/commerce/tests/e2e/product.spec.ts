import { test, expect, request } from '@playwright/test';

test('product detail page loads with JSON-LD', async ({ page, baseURL }) => {
  // Fetch a real product id from public API
  const ctx = await request.newContext({ baseURL });
  const apiRes = await ctx.get('/api/products?limit=1');
  expect(apiRes.status(), '/api/products status').toBe(200);
  const json = await apiRes.json();
  const product = json.products?.[0] ?? json.items?.[0] ?? json[0];
  expect(product, 'has at least one product').toBeTruthy();
  const id = product.id ?? product.slug ?? product.pgId;
  expect(id, 'product has id').toBeTruthy();

  const response = await page.goto(`/product/${id}`);
  expect(response?.status(), 'product page status').toBeLessThan(400);

  // JSON-LD <script> should be present in head
  const ldCount = await page.locator('script[type="application/ld+json"]').count();
  expect(ldCount, 'JSON-LD blocks').toBeGreaterThan(0);

  // Body shouldn't be a generic error
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/internal server error|application error/i);
});
