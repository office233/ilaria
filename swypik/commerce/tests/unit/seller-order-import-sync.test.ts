import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let inserted = true;

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO seller_imported_orders")) {
        return {
          rows: [{ id: "33333333-3333-4333-8333-333333333333", inserted }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
}));

import { syncOrderPage } from "@/lib/seller/imports/orders";
import type { CatalogConnection, ExternalOrder } from "@/lib/seller/imports/types";

const connection: CatalogConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  sellerId: "22222222-2222-4222-8222-222222222222",
  provider: "shopify",
  externalAccountId: "store.myshopify.com",
  credentials: { accessToken: "secret" },
  config: {},
  status: "active",
  lastSyncAt: null,
  lastSyncCursor: null,
  lastErrorCode: null,
  lastCustomerSyncAt: null,
  lastCustomerSyncCursor: null,
  lastCustomerErrorCode: null,
  lastOrderSyncAt: null,
  lastOrderSyncCursor: null,
  lastOrderErrorCode: null,
  webhookStatus: "pending",
  webhookConfig: {},
  webhooksUpdatedAt: null,
  lastReconcileAt: null,
  lastReconcileErrorCode: null,
};

const order: ExternalOrder = {
  externalId: "gid://shopify/Order/1",
  orderNumber: "#1001",
  normalizedStatus: "fulfilled",
  providerStatus: "PAID",
  financialStatus: "PAID",
  fulfillmentStatus: "FULFILLED",
  currency: "EUR",
  subtotalCents: 2000,
  discountCents: 100,
  shippingCents: 400,
  taxCents: 200,
  totalCents: 2500,
  refundedCents: 0,
  customerExternalId: "gid://shopify/Customer/1",
  customerName: null,
  customerEmail: null,
  customerPhone: null,
  placedAt: "2026-08-01T10:00:00Z",
  cancelledAt: null,
  items: [{
    externalId: "gid://shopify/LineItem/1",
    externalProductId: "gid://shopify/Product/1",
    externalVariantId: "gid://shopify/ProductVariant/1",
    title: "Product",
    sku: "SKU-1",
    quantity: 2,
    currency: "EUR",
    unitAmountCents: 1000,
    totalAmountCents: 2000,
    metadata: {},
  }],
  itemsComplete: true,
  metadata: {},
};

beforeEach(() => {
  calls = [];
  inserted = true;
});

describe("syncOrderPage", () => {
  it("stores history outside commerce_orders and upserts line items", async () => {
    const result = await syncOrderPage(connection, { orders: [order], nextCursor: null });
    expect(result).toMatchObject({ inspected: 1, created: 1, updated: 0, failed: 0 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO seller_imported_orders"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("seller_imported_order_items"))).toBe(true);
    expect(calls.some((c) => /\bcommerce_orders\b/.test(c.sql))).toBe(false);
  });

  it("updates the same external order idempotently", async () => {
    inserted = false;
    const result = await syncOrderPage(connection, { orders: [order], nextCursor: null });
    expect(result).toMatchObject({ created: 0, updated: 1, failed: 0 });
  });

  it("removes stale imported line items only when the provider page is complete", async () => {
    await syncOrderPage(connection, { orders: [order], nextCursor: null });
    expect(calls.some((c) => c.sql.includes("DELETE FROM seller_imported_order_items"))).toBe(true);

    calls = [];
    await syncOrderPage(
      connection,
      { orders: [{ ...order, itemsComplete: false }], nextCursor: null },
    );
    expect(calls.some((c) => c.sql.includes("DELETE FROM seller_imported_order_items"))).toBe(false);
  });
});
