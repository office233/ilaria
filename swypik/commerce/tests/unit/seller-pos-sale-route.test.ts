import { describe, it, expect, vi, beforeEach } from "vitest";

let sellerId: string | null = "seller-1";
let stockByProduct: Record<string, number> = {};

vi.mock("@/lib/security/seller-auth", () => ({
  getSellerSessionId: async () => sellerId,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
}));

vi.mock("@/lib/db", () => {
  const dbQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    // Decrementul atomic de stoc: UPDATE ... WHERE seller_id = $3 AND stoc >= $1
    if (sql.includes("UPDATE marketplace_products")) {
      const [qty, productId, forSeller] = params as [number, string, string];
      if (forSeller !== sellerId) return { rows: [], rowCount: 0 };
      const current = stockByProduct[productId] ?? 0;
      if (current < qty) return { rows: [], rowCount: 0 };
      stockByProduct[productId] = current - qty;
      return { rows: [{ id: productId }], rowCount: 1 };
    }
    // Verificarea de ownership după un update eșuat (distinge not_found de insufficient_stock).
    if (sql.includes("SELECT id FROM marketplace_products WHERE id")) {
      const [productId, forSeller] = params as [string, string];
      if (forSeller !== sellerId || !(productId in stockByProduct)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: productId }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO seller_sequences")) {
      return { rows: [{ value: 1 }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO seller_pos_sales")) {
      return {
        rows: [{ id: "sale-1", receipt_number: "POS-20260101-0001", created_at: new Date().toISOString() }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    dbQuery,
    withTransaction: async <T,>(fn: (q: typeof dbQuery) => Promise<T>) => fn(dbQuery),
  };
});

import { POST } from "@/app/api/seller/pos/sale/route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/seller/pos/sale", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sellerId = "seller-1";
  stockByProduct = { "11111111-1111-1111-8111-111111111111": 5 };
});

describe("POST /api/seller/pos/sale", () => {
  it("rejects an unauthenticated request", async () => {
    sellerId = null;
    const res = await POST(req({ items: [], paymentMethod: "cash" }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with a stable error code (not a raw zod message)", async () => {
    const res = await POST(req({ items: [], paymentMethod: "cash" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("validation_error");
  });

  it("completes a sale and decrements stock when there is enough available", async () => {
    const res = await POST(
      req({
        items: [{ id: "11111111-1111-1111-8111-111111111111", quantity: 2, price: 25 }],
        paymentMethod: "cash",
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.totalCents).toBe(5000);
    expect(stockByProduct["11111111-1111-1111-8111-111111111111"]).toBe(3);
  });

  it("rejects overselling instead of silently clamping stock to 0", async () => {
    const res = await POST(
      req({
        items: [{ id: "11111111-1111-1111-8111-111111111111", quantity: 10, price: 25 }],
        paymentMethod: "cash",
      }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("insufficient_stock");
    // Stocul nu trebuie atins când vânzarea eșuează.
    expect(stockByProduct["11111111-1111-1111-8111-111111111111"]).toBe(5);
  });

  it("rejects a product that doesn't belong to this seller", async () => {
    const res = await POST(
      req({
        items: [{ id: "22222222-2222-2222-8222-222222222222", quantity: 1, price: 10 }],
        paymentMethod: "cash",
      }),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("product_not_found");
  });
});
