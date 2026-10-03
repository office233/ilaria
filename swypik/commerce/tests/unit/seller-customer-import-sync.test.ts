import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let insertResult = true;

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rows: [{ id: "33333333-3333-4333-8333-333333333333", inserted: insertResult }],
        rowCount: 1,
      };
    }),
}));

import { syncCustomerPage } from "@/lib/seller/imports/customers";
import type { CatalogConnection } from "@/lib/seller/imports/types";

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

beforeEach(() => {
  calls = [];
  insertResult = true;
});

describe("syncCustomerPage", () => {
  it("upserts external customers with stable provider identity", async () => {
    const result = await syncCustomerPage(connection, {
      customers: [{
        externalId: "gid://shopify/Customer/1",
        name: "Ana Client",
        email: "ana@example.com",
        phone: "+40123456789",
        address: "Str. Test 1",
        city: "Bucuresti",
        region: "B",
        country: "RO",
        postalCode: "010101",
        notes: null,
      }],
      nextCursor: null,
    });

    expect(result).toMatchObject({ inspected: 1, created: 1, updated: 0, failed: 0 });
    expect(calls[0].sql).toContain("ON CONFLICT");
    expect(calls[0].params).toEqual(expect.arrayContaining([
      connection.sellerId,
      connection.provider,
      connection.externalAccountId,
      "gid://shopify/Customer/1",
    ]));
  });

  it("counts an existing external customer as updated", async () => {
    insertResult = false;
    const result = await syncCustomerPage(connection, {
      customers: [{
        externalId: "42",
        name: "Existing",
        email: null,
        phone: null,
        address: null,
        city: null,
        region: null,
        country: null,
        postalCode: null,
        notes: null,
      }],
      nextCursor: null,
    });
    expect(result).toMatchObject({ created: 0, updated: 1, failed: 0 });
  });
});
