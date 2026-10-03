import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number };
const { labelProduct, autoEmbedProduct } = vi.hoisted(() => ({
  labelProduct: vi.fn(),
  autoEmbedProduct: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return queryHandler(sql, params);
    }),
}));
vi.mock("@/lib/moderation/labelProduct", () => ({ labelProduct }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedProduct }));

import { syncCatalogPage } from "@/lib/seller/imports/sync";
import type {
  CatalogConnection,
  ExternalCatalogProduct,
} from "@/lib/seller/imports/types";

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

const product: ExternalCatalogProduct = {
  externalId: "gid://shopify/Product/1",
  title: "Imported product",
  description: "Description",
  brand: "Brand",
  category: "Category",
  sourceUrl: "https://store.example/products/1",
  currency: "EUR",
  priceCents: 1999,
  compareAtPriceCents: 2499,
  inventoryQuantity: 7,
  imageUrls: ["https://cdn.example.com/1.jpg"],
  status: "active",
  variants: [
    {
      externalId: "gid://shopify/ProductVariant/10",
      sku: "SKU-10",
      title: "Default",
      attributes: { Size: "M" },
      priceCents: 1999,
      compareAtPriceCents: 2499,
      inventoryQuantity: 7,
      inventoryStatus: "in_stock",
    },
  ],
  variantsComplete: true,
  inventoryStatus: "in_stock",
  metadata: { provider: "shopify" },
};

beforeEach(() => {
  calls = [];
  labelProduct.mockReset().mockResolvedValue(undefined);
  autoEmbedProduct.mockReset();
  queryHandler = (sql) => {
    if (sql.includes("SELECT id, seller_id")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO marketplace_products")) {
      return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
});

describe("syncCatalogPage", () => {
  it("creates an external product and upserts its variants", async () => {
    const result = await syncCatalogPage(connection, {
      products: [product],
      nextCursor: null,
      storeCurrency: "EUR",
    });

    expect(result).toMatchObject({ inspected: 1, created: 1, updated: 0, failed: 0 });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO marketplace_products"));
    expect(insert?.params).toEqual(
      expect.arrayContaining([
        "shopify",
        connection.sellerId,
        connection.externalAccountId,
        product.externalId,
      ]),
    );
    expect(calls.some((c) => c.sql.includes("marketplace_product_variants"))).toBe(true);
    expect(labelProduct).toHaveBeenCalledWith(expect.objectContaining({ id: "33333333-3333-4333-8333-333333333333" }));
    expect(autoEmbedProduct).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      product.title,
      product.description,
    );
  });

  it("updates the same product instead of creating a duplicate", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT id, seller_id")) {
        return {
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            seller_id: connection.sellerId,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE marketplace_products")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    const result = await syncCatalogPage(connection, {
      products: [product],
      nextCursor: null,
      storeCurrency: "EUR",
    });

    expect(result).toMatchObject({ created: 0, updated: 1, failed: 0 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO marketplace_products"))).toBe(false);
  });

  it("never overwrites a product owned by another seller", async () => {
    queryHandler = (sql) =>
      sql.includes("SELECT id, seller_id")
        ? {
            rows: [{
              id: "33333333-3333-4333-8333-333333333333",
              seller_id: "44444444-4444-4444-8444-444444444444",
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 1 };

    const result = await syncCatalogPage(connection, {
      products: [product],
      nextCursor: null,
      storeCurrency: "EUR",
    });

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      {
        externalId: product.externalId,
        code: "external_product_owned_by_another_seller",
      },
    ]);
    expect(labelProduct).not.toHaveBeenCalled();
    expect(autoEmbedProduct).not.toHaveBeenCalled();
  });

  it("dry-run performs zero database writes", async () => {
    const result = await syncCatalogPage(
      connection,
      { products: [product], nextCursor: null, storeCurrency: "EUR" },
      true,
    );
    expect(result).toMatchObject({ inspected: 1, dryRun: true });
    expect(calls).toEqual([]);
    expect(labelProduct).not.toHaveBeenCalled();
    expect(autoEmbedProduct).not.toHaveBeenCalled();
  });
});
