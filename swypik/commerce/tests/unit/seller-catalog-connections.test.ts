import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbQuery } = vi.hoisted(() => ({
  dbQuery: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ dbQuery }));

import {
  getCatalogConnection,
  upsertCatalogConnection,
} from "@/lib/seller/imports/connections";

const OLD_KEY = process.env.APP_ENCRYPTION_KEY;

beforeEach(() => {
  dbQuery.mockReset();
  process.env.APP_ENCRYPTION_KEY = "11".repeat(32);
});

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = OLD_KEY;
});

describe("seller catalog integration credentials", () => {
  it("persists credentials encrypted and decrypts them only when loading the connection", async () => {
    const token = "shpat_super_secret_token";
    let encrypted = "";

    dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO seller_catalog_integrations")) {
        encrypted = String(params[3]);
        return {
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            seller_id: "22222222-2222-4222-8222-222222222222",
            provider: "shopify",
            external_account_id: "store.myshopify.com",
            credentials_enc: encrypted,
            config: {},
            status: "active",
            last_sync_at: null,
            last_sync_cursor: null,
            last_error_code: null,
          }],
          rowCount: 1,
        };
      }
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          seller_id: "22222222-2222-4222-8222-222222222222",
          provider: "shopify",
          external_account_id: "store.myshopify.com",
          credentials_enc: encrypted,
          config: {},
          status: "active",
          last_sync_at: null,
          last_sync_cursor: null,
          last_error_code: null,
        }],
        rowCount: 1,
      };
    });

    await upsertCatalogConnection({
      sellerId: "22222222-2222-4222-8222-222222222222",
      provider: "shopify",
      externalAccountId: "store.myshopify.com",
      credentials: { accessToken: token },
    });

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(token);

    const loaded = await getCatalogConnection(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(loaded?.credentials).toEqual({ accessToken: token });
  });
});
