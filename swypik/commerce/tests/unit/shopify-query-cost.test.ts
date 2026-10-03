import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock("@/lib/security/ssrf", () => ({
  safeFetch,
  assertPublicHttpsUrl: vi.fn(async (raw: string) => new URL(raw)),
  parsePublicHttpsUrl: (raw: string) => new URL(raw),
}));

import {
  fetchShopifyCustomerPage,
  fetchShopifyOrderPage,
  shopifyPageSize,
  SHOPIFY_ORDER_PAGE_MAX,
  SHOPIFY_PRODUCT_PAGE_MAX,
} from "@/lib/seller/imports/shopify";

const OLD_VERSION = process.env.SHOPIFY_API_VERSION;
const ARGS = {
  externalAccountId: "store.myshopify.com",
  credentials: { accessToken: "token" },
  cursor: null,
};

function sentFirst(): number {
  const init = safeFetch.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body).variables.first;
}

beforeEach(() => {
  safeFetch.mockReset();
  process.env.SHOPIFY_API_VERSION = "2026-07";
});

afterEach(() => {
  if (OLD_VERSION === undefined) delete process.env.SHOPIFY_API_VERSION;
  else process.env.SHOPIFY_API_VERSION = OLD_VERSION;
});

describe("Shopify GraphQL query cost caps", () => {
  it("clamps page sizes into [1, max]", () => {
    expect(shopifyPageSize(50, SHOPIFY_PRODUCT_PAGE_MAX)).toBe(SHOPIFY_PRODUCT_PAGE_MAX);
    expect(shopifyPageSize(1, SHOPIFY_PRODUCT_PAGE_MAX)).toBe(1);
    expect(shopifyPageSize(0, 10)).toBe(1);
    expect(shopifyPageSize(Number.NaN, 10)).toBe(1);
    expect(shopifyPageSize(1000, 1000)).toBe(250);
  });

  it("keeps the estimated product and order page cost under Shopify's 1000-point limit", () => {
    expect(2 + SHOPIFY_PRODUCT_PAGE_MAX * 171).toBeLessThan(1000);
    expect(2 + SHOPIFY_ORDER_PAGE_MAX * 370).toBeLessThan(1000);
  });

  it("requests at most SHOPIFY_ORDER_PAGE_MAX orders even when a larger limit is asked", async () => {
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    })));
    await fetchShopifyOrderPage({ ...ARGS, limit: 50 } as never);
    expect(sentFirst()).toBe(SHOPIFY_ORDER_PAGE_MAX);
  });

  it("never asks Shopify for more than 250 customers", async () => {
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    })));
    await fetchShopifyCustomerPage({ ...ARGS, limit: 1000 } as never);
    expect(sentFirst()).toBe(250);
  });
});
