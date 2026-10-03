import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch, assertPublicHttpsUrl } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  assertPublicHttpsUrl: vi.fn(),
}));

vi.mock("@/lib/security/ssrf", () => ({
  safeFetch,
  assertPublicHttpsUrl,
  parsePublicHttpsUrl: (raw: string) => new URL(raw),
}));

import { fetchShopifyOrderPage } from "@/lib/seller/imports/shopify";
import { fetchWooCommerceOrderPage } from "@/lib/seller/imports/woocommerce";

const OLD_VERSION = process.env.SHOPIFY_API_VERSION;

beforeEach(() => {
  safeFetch.mockReset();
  assertPublicHttpsUrl.mockReset().mockImplementation(async (raw: string) => new URL(raw));
  process.env.SHOPIFY_API_VERSION = "2026-07";
});

afterEach(() => {
  if (OLD_VERSION === undefined) delete process.env.SHOPIFY_API_VERSION;
  else process.env.SHOPIFY_API_VERSION = OLD_VERSION;
});

describe("external order normalization", () => {
  it("normalizes Shopify current totals and line items", async () => {
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        orders: {
          nodes: [{
            id: "gid://shopify/Order/1",
            name: "#1001",
            createdAt: "2026-08-01T10:00:00Z",
            cancelledAt: null,
            currencyCode: "EUR",
            displayFinancialStatus: "PAID",
            displayFulfillmentStatus: "FULFILLED",
            currentSubtotalPriceSet: { shopMoney: { amount: "20.00", currencyCode: "EUR" } },
            currentTotalDiscountsSet: { shopMoney: { amount: "2.00", currencyCode: "EUR" } },
            currentShippingPriceSet: { shopMoney: { amount: "4.00", currencyCode: "EUR" } },
            currentTotalTaxSet: { shopMoney: { amount: "3.00", currencyCode: "EUR" } },
            currentTotalPriceSet: { shopMoney: { amount: "25.00", currencyCode: "EUR" } },
            originalTotalPriceSet: { shopMoney: { amount: "25.00", currencyCode: "EUR" } },
            netPaymentSet: { shopMoney: { amount: "25.00", currencyCode: "EUR" } },
            totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            customer: { id: "gid://shopify/Customer/1" },
            lineItems: {
              nodes: [{
                id: "gid://shopify/LineItem/1",
                title: "Product",
                sku: "SKU-1",
                currentQuantity: 2,
                originalUnitPriceSet: { shopMoney: { amount: "10.00", currencyCode: "EUR" } },
                priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: "18.00", currencyCode: "EUR" } },
                product: { id: "gid://shopify/Product/1" },
                variant: { id: "gid://shopify/ProductVariant/1" },
              }],
              pageInfo: { hasNextPage: false },
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { status: 200 }));

    const page = await fetchShopifyOrderPage({
      externalAccountId: "store.myshopify.com",
      credentials: { accessToken: "secret-token" },
      limit: 50,
    });

    expect(page.orders[0]).toMatchObject({
      normalizedStatus: "fulfilled",
      currency: "EUR",
      subtotalCents: 2000,
      discountCents: 200,
      shippingCents: 400,
      taxCents: 300,
      totalCents: 2500,
      refundedCents: 0,
      customerExternalId: "gid://shopify/Customer/1",
      itemsComplete: true,
    });
    expect(page.orders[0].items[0]).toMatchObject({
      quantity: 2,
      unitAmountCents: 900,
      totalAmountCents: 1800,
    });
  });

  it("normalizes WooCommerce refunds into net historical revenue", async () => {
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify([{
      id: 77,
      number: "77",
      status: "processing",
      currency: "RON",
      date_created_gmt: "2026-08-02T10:00:00",
      discount_total: "5.00",
      shipping_total: "15.00",
      total_tax: "19.00",
      total: "119.00",
      customer_id: 9,
      billing: {
        first_name: "Ana",
        last_name: "Client",
        email: "ana@example.com",
        phone: "+40123456789",
      },
      line_items: [{
        id: 5,
        name: "Produs",
        product_id: 10,
        variation_id: 11,
        quantity: 1,
        total: "100.00",
        sku: "SKU-10",
        price: 100,
      }],
      refunds: [{ id: 1, total: "20.00" }],
    }]), {
      status: 200,
      headers: { "x-wp-totalpages": "1" },
    }));

    const page = await fetchWooCommerceOrderPage({
      externalAccountId: "https://shop.example.com",
      credentials: { consumerKey: "ck_secret", consumerSecret: "cs_secret" },
      limit: 50,
    });

    expect(page.orders[0]).toMatchObject({
      normalizedStatus: "partially_refunded",
      currency: "RON",
      totalCents: 9900,
      refundedCents: 2000,
      customerExternalId: "9",
      customerName: "Ana Client",
      customerEmail: "ana@example.com",
    });
  });

  it("does not count a fulfilled but unpaid Shopify order as revenue", async () => {
    safeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      data: {
        orders: {
          nodes: [{
            id: "gid://shopify/Order/2",
            name: "#1002",
            createdAt: "2026-08-03T10:00:00Z",
            cancelledAt: null,
            currencyCode: "EUR",
            displayFinancialStatus: "PENDING",
            displayFulfillmentStatus: "FULFILLED",
            currentSubtotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "EUR" } },
            currentTotalDiscountsSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            currentShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            currentTotalTaxSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            currentTotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "EUR" } },
            originalTotalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "EUR" } },
            netPaymentSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "EUR" } },
            customer: null,
            lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { status: 200 }));

    const page = await fetchShopifyOrderPage({
      externalAccountId: "store.myshopify.com",
      credentials: { accessToken: "secret-token" },
      limit: 50,
    });
    expect(page.orders[0]).toMatchObject({
      normalizedStatus: "open",
      totalCents: 0,
    });
  });
});
