import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  withAdvisoryLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  getConnection: vi.fn(),
  fetchProduct: vi.fn(),
  fetchCustomer: vi.fn(),
  fetchOrder: vi.fn(),
  syncCatalog: vi.fn(),
  syncCustomers: vi.fn(),
  syncOrders: vi.fn(),
  archiveProduct: vi.fn(),
  cleanupOAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  dbQuery: h.dbQuery,
  withAdvisoryLock: h.withAdvisoryLock,
}));
vi.mock("@/lib/seller/imports/connections", () => ({
  getCatalogConnectionById: h.getConnection,
  markCatalogSyncFailure: vi.fn(),
  markCatalogSyncSuccess: vi.fn(),
  markCustomerSyncFailure: vi.fn(),
  markCustomerSyncSuccess: vi.fn(),
  markOrderSyncFailure: vi.fn(),
  markOrderSyncSuccess: vi.fn(),
  markReconcileResult: vi.fn(),
}));
vi.mock("@/lib/seller/imports/provider", () => ({
  fetchCatalogPage: vi.fn(),
  fetchCustomerById: h.fetchCustomer,
  fetchCustomerPage: vi.fn(),
  fetchOrderById: h.fetchOrder,
  fetchOrderPage: vi.fn(),
  fetchProductById: h.fetchProduct,
}));
vi.mock("@/lib/seller/imports/customers", () => ({ syncCustomerPage: h.syncCustomers }));
vi.mock("@/lib/seller/imports/orders", () => ({ syncOrderPage: h.syncOrders }));
vi.mock("@/lib/seller/imports/sync", () => ({
  archiveExternalProduct: h.archiveProduct,
  syncCatalogPage: h.syncCatalog,
}));
vi.mock("@/lib/seller/imports/webhook-events", () => ({
  claimWebhookEvents: vi.fn(),
  completeWebhookEvent: vi.fn(),
  failWebhookEvent: vi.fn(),
  webhookQueueStats: vi.fn(),
}));
vi.mock("@/lib/seller/imports/webhooks", () => ({
  ensureIntegrationWebhooks: vi.fn(),
}));
vi.mock("@/lib/seller/imports/shopify-oauth", () => ({
  cleanupExpiredShopifyOAuthStates: h.cleanupOAuth,
}));

import { processIntegrationWebhookEvent } from "@/lib/seller/imports/integration-worker";

const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  sellerId: "22222222-2222-4222-8222-222222222222",
  provider: "shopify" as const,
  externalAccountId: "store.myshopify.com",
  credentials: { accessToken: "secret" },
  config: {},
  status: "active" as const,
  lastSyncAt: null,
  lastSyncCursor: null,
  lastErrorCode: null,
  lastCustomerSyncAt: null,
  lastCustomerSyncCursor: null,
  lastCustomerErrorCode: null,
  lastOrderSyncAt: null,
  lastOrderSyncCursor: null,
  lastOrderErrorCode: null,
  webhookStatus: "active" as const,
  webhookConfig: {},
  webhooksUpdatedAt: null,
  lastReconcileAt: null,
  lastReconcileErrorCode: null,
};

const event = {
  id: "33333333-3333-4333-8333-333333333333",
  integrationId: connection.id,
  provider: "shopify" as const,
  deliveryId: "delivery-1",
  topic: "products/delete",
  resource: "product" as const,
  action: "delete" as const,
  externalResourceId: "gid://shopify/Product/123",
  attempts: 1,
};

beforeEach(() => {
  h.dbQuery.mockReset();
  h.withAdvisoryLock.mockClear();
  h.getConnection.mockReset().mockResolvedValue(connection);
  h.fetchProduct.mockReset();
  h.fetchCustomer.mockReset();
  h.fetchOrder.mockReset();
  h.syncCatalog.mockReset().mockResolvedValue({
    inspected: 1, created: 0, updated: 1, failed: 0, dryRun: false, errors: [],
  });
  h.syncCustomers.mockReset();
  h.syncOrders.mockReset();
  h.archiveProduct.mockReset().mockResolvedValue(undefined);
  h.cleanupOAuth.mockReset().mockResolvedValue(0);
});

describe("integration webhook worker", () => {
  it("re-fetches current state even for a delete event, preventing stale out-of-order archive", async () => {
    h.fetchProduct.mockResolvedValue({
      externalId: event.externalResourceId,
      title: "Recreated",
      description: null,
      brand: null,
      category: null,
      sourceUrl: null,
      currency: "EUR",
      priceCents: 1000,
      compareAtPriceCents: null,
      inventoryQuantity: 1,
      inventoryStatus: "in_stock",
      imageUrls: [],
      status: "active",
      variants: [],
      variantsComplete: true,
      metadata: {},
    });

    await processIntegrationWebhookEvent(event);
    expect(h.syncCatalog).toHaveBeenCalledTimes(1);
    expect(h.archiveProduct).not.toHaveBeenCalled();
  });

  it("archives only when the provider confirms the product no longer exists", async () => {
    h.fetchProduct.mockResolvedValue(null);
    await processIntegrationWebhookEvent(event);
    expect(h.archiveProduct).toHaveBeenCalledWith(connection, event.externalResourceId);
    expect(h.syncCatalog).not.toHaveBeenCalled();
  });
});
