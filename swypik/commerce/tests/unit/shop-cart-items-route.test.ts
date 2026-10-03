import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/cart/items: prețul vine din catalog, varianta e căutată după id ȘI
// produs, produsele cu variante cer varianta, listările nu intră în coș.

const PRODUCT = "11111111-1111-1111-1111-111111111111";
const VARIANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 5 })),
  getClientIP: () => "127.0.0.1",
}));
vi.mock("@/lib/cart/session", () => ({
  getOrCreateCart: vi.fn(async () => ({ cartId: "cart-1", userId: "u-1", anonToken: null, currency: "RON" })),
  buildCartCookie: () => "c=1",
}));

type Q = { sql: string; params: unknown[] };
const queries: Q[] = [];
let product: Record<string, unknown> | null;
let variantRow: Record<string, unknown> | null;

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("AS has_variants")) return { rows: product ? [product] : [], rowCount: 1 };
    if (sql.includes("FROM marketplace_product_variants") && sql.includes("product_id = $2::uuid")) {
      return { rows: variantRow ? [variantRow] : [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { POST } from "@/app/api/cart/items/route";

const req = (body: unknown) =>
  new Request("http://localhost/api/cart/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  queries.length = 0;
  product = { id: PRODUCT, title: "Tricou", price_cents: 5000, currency: "RON", image_url: null, purchasable: true, has_variants: true };
  variantRow = { id: VARIANT, price_cents: 6500 };
});

describe("POST /api/cart/items", () => {
  it("stores the variant price from the DB and ignores the client price", async () => {
    const res = await POST(req({ productId: PRODUCT, variantId: VARIANT, quantity: 2, priceCents: 1, title: "hack" }));
    expect(res.status).toBe(200);
    const variantLookup = queries.find((q) => q.sql.includes("product_id = $2::uuid"))!;
    expect(variantLookup.params).toEqual([VARIANT, PRODUCT]);
    const insert = queries.find((q) => q.sql.includes("INSERT INTO cart_items"))!;
    expect(insert.params[3]).toBe("Tricou");
    expect(insert.params[6]).toBe(6500);
  });

  it("rejects a variant that does not belong to the product", async () => {
    variantRow = null;
    const res = await POST(req({ productId: PRODUCT, variantId: VARIANT }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("variant_unavailable");
    expect(queries.some((q) => q.sql.includes("INSERT INTO cart_items"))).toBe(false);
  });

  it("requires a variant when the product has variants", async () => {
    const res = await POST(req({ productId: PRODUCT }));
    expect((await res.json()).code).toBe("variant_required");
  });

  it("refuses listings / unpurchasable products and unknown ids", async () => {
    product = { ...product!, purchasable: false };
    expect((await (await POST(req({ productId: PRODUCT }))).json()).code).toBe("not_purchasable");
    product = null;
    expect((await POST(req({ productId: PRODUCT }))).status).toBe(404);
    expect((await POST(req({ productId: "ext-123" }))).status).toBe(400);
  });

  it("persists the source video for creator attribution", async () => {
    const video = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await POST(req({ productId: PRODUCT, variantId: VARIANT, videoId: video }));
    const insert = queries.find((q) => q.sql.includes("INSERT INTO cart_items"))!;
    expect(insert.params[7]).toBe(video);
  });
});
