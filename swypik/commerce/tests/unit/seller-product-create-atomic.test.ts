import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  txQuery: vi.fn(),
  autoEmbed: vi.fn(),
  labelProduct: vi.fn(),
  upsertTranslation: vi.fn(),
  translate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(),
  withTransaction: async (fn: (q: typeof h.txQuery) => Promise<unknown>) => fn(h.txQuery),
}));
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: vi.fn(async () => "seller-1") }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ success: true, remaining: 10 })) }));
vi.mock("@/lib/moderation/labelProduct", () => ({ labelProduct: (...args: unknown[]) => h.labelProduct(...args) }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedProduct: (...args: unknown[]) => h.autoEmbed(...args) }));
vi.mock("@/lib/ai/product-translator", () => ({ translateProductToLocales: (...args: unknown[]) => h.translate(...args) }));
vi.mock("@/lib/seller/products", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seller/products")>();
  return { ...actual, upsertSellerProductTranslation: (...args: unknown[]) => h.upsertTranslation(...args) };
});
vi.mock("@/lib/seller/request-locale", () => ({
  sellerRequestLocale: vi.fn(async () => "ro"),
  sellerTranslationTargets: vi.fn(() => ["en"]),
}));

import { POST } from "@/app/api/seller/products/route";

const body = {
  title: "Produs atomic",
  price: 100,
  currency: "RON",
  stock: 4,
  variants: [
    { sku: "A", title: "A", price_cents: 10_000, inventory_quantity: 2 },
    { sku: "B", title: "B", price_cents: 11_000, inventory_quantity: 2 },
  ],
};

beforeEach(() => {
  h.txQuery.mockReset();
  h.autoEmbed.mockReset();
  h.labelProduct.mockReset().mockResolvedValue(undefined);
  h.upsertTranslation.mockReset().mockResolvedValue(undefined);
  h.translate.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/seller/products atomic create", () => {
  it("creates product and variants through the same transaction query", async () => {
    h.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: "product-1", title: body.title, category: "General" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const response = await POST(new Request("http://x/api/seller/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(h.txQuery).toHaveBeenCalledTimes(2);
    expect(String(h.txQuery.mock.calls[0][0])).toContain("INSERT INTO marketplace_products");
    expect(String(h.txQuery.mock.calls[1][0])).toContain("INSERT INTO marketplace_product_variants");
    expect(h.autoEmbed).toHaveBeenCalledWith("product-1", body.title, null);
  });

  it("does not report success when variant persistence fails", async () => {
    h.txQuery
      .mockResolvedValueOnce({
        rows: [{ id: "product-1", title: body.title, category: "General" }],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error("variant insert failed"));

    const response = await POST(new Request("http://x/api/seller/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(500);
    expect(h.autoEmbed).not.toHaveBeenCalled();
    expect(h.upsertTranslation).not.toHaveBeenCalled();
  });
});
