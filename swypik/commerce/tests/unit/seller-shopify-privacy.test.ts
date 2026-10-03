import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };
let txCalls: Call[] = [];
const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));

vi.mock("@/lib/db", () => ({
  dbQuery,
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      txCalls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
}));

import {
  recordShopifyDataRequest,
  redactShopifyCustomer,
  redactShopifyShop,
} from "@/lib/seller/imports/shopify-privacy";

beforeEach(() => {
  txCalls = [];
  dbQuery.mockReset();
});

describe("Shopify privacy data handling", () => {
  it("records a data request without persisting email or phone from the payload", async () => {
    dbQuery
      .mockResolvedValueOnce({
        rows: [{ seller_id: "22222222-2222-4222-8222-222222222222" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await recordShopifyDataRequest(
      {
        shop_domain: "store.myshopify.com",
        customer: {
          id: 7,
          email: "private@example.com",
          phone: "+40123456789",
        },
        data_request: { id: 55 },
        orders_requested: [91],
      },
      "a".repeat(64),
    );

    const insert = dbQuery.mock.calls[1];
    expect(String(insert[0])).toContain("seller_shopify_privacy_requests");
    const serializedParams = JSON.stringify(insert[1]);
    expect(serializedParams).not.toContain("private@example.com");
    expect(serializedParams).not.toContain("+40123456789");
    expect(serializedParams).toContain("gid://shopify/Order/91");
  });

  it("redacts imported CRM and customer PII without touching native commerce_orders", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ seller_id: "22222222-2222-4222-8222-222222222222" }],
      rowCount: 1,
    });

    await redactShopifyCustomer(
      {
        shop_domain: "store.myshopify.com",
        customer: { id: 7 },
        orders_to_redact: [91],
      },
      "b".repeat(64),
    );

    const sql = txCalls.map((call) => call.sql).join("\n");
    expect(sql).toContain("DELETE FROM seller_clients");
    expect(sql).toContain("UPDATE seller_imported_orders");
    expect(sql).not.toMatch(/\bUPDATE\s+commerce_orders\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+commerce_orders\b/i);
  });

  it("shop/redact removes all Shopify-imported store data and credentials", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ seller_id: "22222222-2222-4222-8222-222222222222" }],
      rowCount: 1,
    });

    await redactShopifyShop(
      { shop_id: 1, shop_domain: "store.myshopify.com" },
      "c".repeat(64),
    );

    const sql = txCalls.map((call) => call.sql).join("\n");
    expect(sql).toContain("DELETE FROM seller_clients");
    expect(sql).toContain("DELETE FROM marketplace_products");
    expect(sql).toContain("DELETE FROM seller_imported_orders");
    expect(sql).toContain("DELETE FROM seller_catalog_integrations");
    expect(sql).toContain("DELETE FROM seller_shopify_oauth_states");
  });
});
