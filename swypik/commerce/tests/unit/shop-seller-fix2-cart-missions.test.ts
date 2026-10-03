import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let handler: (sql: string) => { rows: unknown[]; rowCount?: number } | undefined = () => undefined;

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql) ?? { rows: [], rowCount: 0 };
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/auth/getAuthUser", () => ({
  getAuthUser: async () => ({ userId: null }),
  requireAuth: async () => ({ userId: "u1", sellerId: "seller-1", role: "seller" }),
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
const createFundingIntent = vi.fn();
vi.mock("@/lib/missions/funding", () => ({ createFundingIntent: (...a: unknown[]) => createFundingIntent(...a) }));

beforeEach(() => {
  calls.length = 0;
  handler = () => undefined;
  createFundingIntent.mockReset();
});

describe("mergeAnonCartToUser", () => {
  it("limitează cantitățile la SHOP_MAX_LINE_QTY (nu 99)", async () => {
    process.env.SHOP_MAX_LINE_QTY = "10";
    handler = (sql) => {
      if (sql.includes("FROM carts WHERE external_cart_id")) return { rows: [{ id: "anon" }] };
      if (sql.includes("FROM carts WHERE user_id")) return { rows: [{ id: "user-cart" }] };
      if (sql.includes("FROM cart_items WHERE cart_id")) {
        return {
          rows: [
            { id: "i1", external_product_id: "p1", external_variant_id: null, quantity: 8, metadata: { mergeable: true } },
            { id: "i2", external_product_id: "p2", external_variant_id: null, quantity: 50, metadata: null },
          ],
        };
      }
      if (sql.includes("LEAST(quantity + $1")) return { rows: [], rowCount: 1 };
    };
    const { mergeAnonCartToUser } = await import("@/lib/cart/session");
    await mergeAnonCartToUser("tok", "u1");
    const merged = calls.find((c) => c.sql.includes("LEAST(quantity + $1"));
    expect(merged?.params[4]).toBe(10);
    const moved = calls.find((c) => c.sql.includes("SET cart_id = $1, quantity = LEAST(quantity, $3)"));
    expect(moved?.params).toEqual(["user-cart", "i2", 10]);
  });
});

describe("POST /api/seller/missions/[id]/fund", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const req = () => new Request(`http://localhost/api/seller/missions/${ID}/fund`, { method: "POST" });

  it("cheie Stripe placeholder → 503 payments_unavailable (nu 502)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_placeholder";
    const { POST } = await import("@/app/api/seller/missions/[id]/fund/route");
    const res = await POST(req(), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("payments_unavailable");
    expect(createFundingIntent).not.toHaveBeenCalled();
  });

  it("eroare de autentificare Stripe → 503 payments_unavailable", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
    createFundingIntent.mockRejectedValueOnce(Object.assign(new Error("auth"), { type: "StripeAuthenticationError" }));
    const { POST } = await import("@/app/api/seller/missions/[id]/fund/route");
    const res = await POST(req(), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(503);
  });
});
