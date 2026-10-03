import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  safeFetch: vi.fn(),
  updateWebhookState: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ dbQuery: h.dbQuery }));
vi.mock("@/lib/security/ssrf", () => ({ safeFetch: h.safeFetch }));
vi.mock("@/lib/seller/imports/connections", () => ({
  updateWebhookState: h.updateWebhookState,
}));

import { ensureIntegrationWebhooks } from "@/lib/seller/imports/webhooks";
import type { CatalogConnection } from "@/lib/seller/imports/types";

const OLD_SHOPIFY_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const OLD_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY;

function connection(provider: "shopify" | "woocommerce"): CatalogConnection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sellerId: "22222222-2222-4222-8222-222222222222",
    provider,
    externalAccountId:
      provider === "shopify" ? "store.myshopify.com" : "https://shop.example.com",
    credentials:
      provider === "shopify"
        ? { accessToken: "shpat_secret_token" }
        : { consumerKey: "ck_secret_key", consumerSecret: "cs_secret_value" },
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
}

beforeEach(() => {
  h.dbQuery.mockReset();
  h.safeFetch.mockReset();
  h.updateWebhookState.mockReset().mockResolvedValue(undefined);
  process.env.APP_ENCRYPTION_KEY = "22".repeat(32);
  delete process.env.SHOPIFY_CLIENT_SECRET;
});

afterEach(() => {
  if (OLD_SHOPIFY_SECRET === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
  else process.env.SHOPIFY_CLIENT_SECRET = OLD_SHOPIFY_SECRET;
  if (OLD_ENCRYPTION_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = OLD_ENCRYPTION_KEY;
});

describe("seller integration webhook setup", () => {
  it("marks Shopify auto-sync unavailable when the app secret is not configured", async () => {
    const result = await ensureIntegrationWebhooks(connection("shopify"));
    expect(result).toMatchObject({ status: "unavailable", configured: 0 });
    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.updateWebhookState).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable",
    }));
  });

  it("creates missing WooCommerce hooks with a generated encrypted secret", async () => {
    h.dbQuery.mockResolvedValue({ rows: [{ webhook_secret_enc: null }], rowCount: 1 });
    let nextId = 100;
    h.safeFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      nextId += 1;
      return new Response(JSON.stringify({ id: nextId }), { status: 200 });
    });

    const result = await ensureIntegrationWebhooks(connection("woocommerce"));
    expect(result).toEqual({
      status: "active",
      configured: 9,
      expected: 9,
      errors: [],
    });
    expect(h.safeFetch).toHaveBeenCalledTimes(10);
    expect(h.updateWebhookState).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending",
      encryptedSecret: expect.stringMatching(/^v1:/),
    }));
    expect(h.updateWebhookState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "active",
      config: expect.objectContaining({
        subscriptions: expect.arrayContaining([
          expect.objectContaining({ topic: "order.updated" }),
        ]),
      }),
    }));
  });
});
