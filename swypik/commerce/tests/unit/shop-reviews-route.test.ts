import { describe, it, expect, vi, beforeEach } from "vitest";

// /api/products/[id]/reviews — doar cumpărătorii verificați pot scrie,
// agregatul include distribuția pe stele, sortările sunt whitelist.

const PRODUCT = "11111111-1111-1111-1111-111111111111";
const getAuthSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAuthSession: () => getAuthSession() }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ success: true, remaining: 5 })) }));

type Q = { sql: string; params: unknown[] };
const queries: Q[] = [];
let productExists = true;
let reviewed = false;
let verifiedOrder: string | null = "order-1";
let insertError: unknown = null;

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM marketplace_products")) return { rows: productExists ? [{ id: PRODUCT }] : [], rowCount: 0 };
    if (sql.includes("AS reviewed")) return { rows: [{ reviewed, order_id: verifiedOrder }], rowCount: 1 };
    if (sql.includes("INSERT INTO product_reviews")) {
      if (insertError) throw insertError;
      return { rows: [{ id: "review-1" }], rowCount: 1 };
    }
    if (sql.includes("GROUP BY rating")) return { rows: [{ rating: 5, n: 3 }, { rating: 4, n: 1 }], rowCount: 2 };
    if (sql.includes("FROM product_reviews r")) {
      return {
        rows: [{ id: "r1", rating: 5, title: "Super", body: "ok", is_verified_purchase: true, helpful_count: 2, created_at: "2026-09-01T00:00:00Z", author: "Ana" }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { GET, POST } from "@/app/api/products/[id]/reviews/route";

const ctx = (id = PRODUCT) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request(`http://localhost/api/products/${PRODUCT}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  queries.length = 0;
  productExists = true;
  reviewed = false;
  verifiedOrder = "order-1";
  insertError = null;
  getAuthSession.mockResolvedValue({ userId: "user-1" });
});

describe("GET reviews", () => {
  it("returns items plus a summary with star distribution", async () => {
    const res = await GET(new Request(`http://localhost/api/products/${PRODUCT}/reviews?sort=rating_low`), ctx());
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({ rating: 5, author: "Ana", isVerifiedPurchase: true });
    expect(json.summary).toEqual({ average: 4.8, total: 4, distribution: [0, 0, 0, 1, 3] });
    expect(json.sort).toBe("rating_low");
    expect(queries.find((q) => q.sql.includes("FROM product_reviews r"))?.sql).toContain("r.rating ASC");
  });

  it("falls back to recent on unknown sort (no SQL injection via sort)", async () => {
    const res = await GET(new Request(`http://localhost/api/products/${PRODUCT}/reviews?sort=1;DROP`), ctx());
    expect((await res.json()).sort).toBe("recent");
  });

  it("rejects non-uuid ids", async () => {
    const res = await GET(new Request("http://localhost/x"), ctx("abc"));
    expect(res.status).toBe(400);
  });
});

describe("POST reviews", () => {
  it("requires login", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(post({ rating: 5 }), ctx());
    expect(res.status).toBe(401);
  });

  it("refuses users without a paid order for the product", async () => {
    verifiedOrder = null;
    const res = await POST(post({ rating: 4 }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_verified_buyer");
    expect(queries.some((q) => q.sql.includes("INSERT INTO product_reviews"))).toBe(false);
  });

  it("creates a verified review linked to the order (null title/body accepted)", async () => {
    const res = await POST(post({ rating: 5, title: null, body: "Foarte bun" }), ctx());
    expect(res.status).toBe(201);
    const insert = queries.find((q) => q.sql.includes("INSERT INTO product_reviews"))!;
    expect(insert.params).toEqual([PRODUCT, "user-1", "order-1", 5, null, "Foarte bun"]);
    expect(insert.sql).toContain("true");
  });

  it("returns 409 when already reviewed", async () => {
    reviewed = true;
    const res = await POST(post({ rating: 5 }), ctx());
    expect(res.status).toBe(409);
  });

  it("maps a unique-violation race to 409", async () => {
    insertError = Object.assign(new Error("dup"), { code: "23505" });
    const res = await POST(post({ rating: 5 }), ctx());
    expect(res.status).toBe(409);
  });

  it("validates the rating", async () => {
    const res = await POST(post({ rating: 6 }), ctx());
    expect(res.status).toBe(400);
  });

  it("404 for unknown product", async () => {
    productExists = false;
    const res = await POST(post({ rating: 3 }), ctx());
    expect(res.status).toBe(404);
  });
});
