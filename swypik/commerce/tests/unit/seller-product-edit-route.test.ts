import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let current: Record<string, unknown> | null = { price_cents: 10000, compare_at_price_cents: null, currency: "RON" };
let updateError: Error | null = null;
let archivedRows = 1;
let sellerId: string | null = "seller-1";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";

function respond(sql: string, params: unknown[]) {
  calls.push({ sql, params });
  if (sql.includes("FOR UPDATE")) return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
  if (sql.startsWith("UPDATE marketplace_products SET") && sql.includes("RETURNING")) {
    if (updateError) throw updateError;
    return { rows: [{ id: PRODUCT_ID, title: "Nou", description: null, category: "General" }], rowCount: 1 };
  }
  if (sql.includes("SET status = 'archived', updated_at = now() WHERE id = $1 AND seller_id = $2")) {
    return { rows: [], rowCount: archivedRows };
  }
  if (sql.includes("FROM marketplace_products WHERE id = $1 AND seller_id = $2")) {
    return { rows: current ? [{ id: PRODUCT_ID, title: "Vechi" }] : [], rowCount: 1 };
  }
  if (sql.includes("FROM marketplace_product_variants")) return { rows: [{ id: VARIANT_ID, title: "M" }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

vi.mock("@/lib/db", () => {
  const q = vi.fn(async (sql: string, params: unknown[] = []) => respond(sql, params));
  return { dbQuery: q, withTransaction: async <T,>(fn: (tx: typeof q) => Promise<T>) => fn(q) };
});
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => sellerId }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 10 }) }));
vi.mock("@/lib/moderation/labelProduct", () => ({ labelProduct: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedProduct: vi.fn() }));
vi.mock("@/lib/ai/product-translator", () => ({ translateProductToLocales: vi.fn(async () => undefined) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "ro" }) }) }));

import { GET, PATCH, DELETE } from "@/app/api/seller/products/[id]/route";
import { labelProduct } from "@/lib/moderation/labelProduct";

const ctx = (id = PRODUCT_ID) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = PRODUCT_ID) =>
  PATCH(new Request(`http://x/api/seller/products/${id}`, { method: "PATCH", body: JSON.stringify(body) }), ctx(id));

beforeEach(() => {
  calls = [];
  current = { price_cents: 10000, compare_at_price_cents: null, currency: "RON" };
  updateError = null;
  archivedRows = 1;
  sellerId = "seller-1";
  vi.mocked(labelProduct).mockClear();
});

describe("PATCH /api/seller/products/[id]", () => {
  it("fără sesiune → 401; id invalid → 400", async () => {
    sellerId = null;
    expect((await patch({ title: "Nou titlu" })).status).toBe(401);
    sellerId = "seller-1";
    expect((await patch({ title: "Nou titlu" }, "nu-e-uuid")).status).toBe(400);
  });

  it("corp gol sau câmpuri necunoscute → validation_error", async () => {
    const r1 = await patch({});
    expect(r1.status).toBe(400);
    const r2 = await patch({ seller_id: "altul" });
    expect((await r2.json()).error).toBe("validation_error");
  });

  it("interval de livrare inversat → invalid_shipping_days", async () => {
    const res = await patch({ shipping_days_min: 5, shipping_days_max: 2 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_shipping_days");
  });

  it("produsul altui seller → 404 (ownership în WHERE)", async () => {
    current = null;
    const res = await patch({ price: 12 });
    expect(res.status).toBe(404);
    const lock = calls.find((c) => c.sql.includes("FOR UPDATE"));
    expect(lock?.params).toEqual([PRODUCT_ID, "seller-1"]);
  });

  it("preț comparativ sub prețul (existent) → 422 compare_below_price", async () => {
    const res = await patch({ compare_at_price: 50 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("compare_below_price");
  });

  it("preț sub cost (constrângerea DB) → 422 price_below_cost", async () => {
    updateError = Object.assign(new Error("check"), { code: "23514" });
    const res = await patch({ price: 1 });
    expect((await res.json()).error).toBe("price_below_cost");
  });

  it("stoc + preț + imagini: coloane și metadata actualizate parametrizat", async () => {
    const res = await patch({ price: 12.5, stock: 0, image_urls: ["https://cdn.example/a.jpg"] });
    expect(res.status).toBe(200);
    const upd = calls.find((c) => c.sql.startsWith("UPDATE marketplace_products SET") && c.sql.includes("RETURNING"));
    expect(upd?.sql).toContain("price_cents = $3");
    expect(upd?.sql).toContain("inventory_status = $4");
    expect(upd?.sql).toContain("metadata = metadata || $6::jsonb");
    expect(upd?.params.slice(0, 5)).toEqual([PRODUCT_ID, "seller-1", 1250, "out_of_stock", "https://cdn.example/a.jpg"]);
    expect(JSON.parse(String(upd?.params[5]))).toEqual({ available_stock: 0, image_urls: ["https://cdn.example/a.jpg"] });
    // Textul nu s-a schimbat → fără re-moderare.
    expect(labelProduct).not.toHaveBeenCalled();
  });

  it("titlu schimbat → re-moderare + traducere", async () => {
    await patch({ title: "Titlu nou" });
    expect(labelProduct).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.sql.includes("INSERT INTO product_translations"))).toBe(true);
  });

  it("variante: lista completă — arhivează lipsă, actualizează cu id, inserează noi", async () => {
    const res = await patch({
      variants: [
        { id: VARIANT_ID, title: "M", price_cents: 1500, inventory_quantity: 3 },
        { title: "L", inventory_quantity: 0 },
      ],
    });
    expect(res.status).toBe(200);
    const archive = calls.find((c) => c.sql.includes("UPDATE marketplace_product_variants SET status = 'archived'"));
    expect(archive?.params).toEqual([PRODUCT_ID, [VARIANT_ID]]);
    const upd = calls.find((c) => c.sql.includes("UPDATE marketplace_product_variants\n            SET sku"));
    expect(upd?.params).toEqual([VARIANT_ID, PRODUCT_ID, null, "M", "{}", 1500, 3, "active"]);
    const ins = calls.find((c) => c.sql.includes("INSERT INTO marketplace_product_variants"));
    // Fără preț propriu → moștenește prețul produsului; stoc 0 → out_of_stock.
    expect(ins?.params).toEqual([PRODUCT_ID, "RON", null, "L", "{}", 10000, 0, "out_of_stock"]);
  });
});

describe("GET / DELETE /api/seller/products/[id]", () => {
  it("GET întoarce produsul cu variantele", async () => {
    const res = await GET(new Request("http://x"), ctx());
    const json = await res.json();
    expect(json.product.variants).toHaveLength(1);
  });
  it("GET pe produs străin → 404", async () => {
    current = null;
    expect((await GET(new Request("http://x"), ctx())).status).toBe(404);
  });
  it("DELETE arhivează (nu șterge); produs străin → 404", async () => {
    const ok = await DELETE(new Request("http://x", { method: "DELETE" }), ctx());
    expect(await ok.json()).toEqual({ success: true, status: "archived" });
    expect(calls.some((c) => c.sql.startsWith("DELETE"))).toBe(false);
    archivedRows = 0;
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx())).status).toBe(404);
  });
});
