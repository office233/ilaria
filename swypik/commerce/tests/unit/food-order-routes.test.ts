import { describe, it, expect, vi, beforeEach } from "vitest";

/** w2-food: rutele de status (restaurant/curier), anulare client, sugestii. */

vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
let sessionUser: string | null = null;
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => (sessionUser ? { userId: sessionUser } : null) }));
let sellerId: string | null = "seller-1";
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => sellerId }));
let rlOk = true;
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: rlOk, remaining: 1 }),
  getClientIP: () => "198.51.100.7",
}));
const effects = vi.fn(async (_a: unknown) => ({ refund: { status: "succeeded", ledgerReversed: 0 } }));
vi.mock("@/lib/food/transition-effects", () => ({ runTransitionEffects: (a: unknown) => effects(a) }));
const suggestMerchant = vi.fn();
vi.mock("@/lib/food/suggestions", async (orig) => ({
  ...(await orig<typeof import("@/lib/food/suggestions")>()),
  suggestMerchant: (...a: unknown[]) => suggestMerchant(...a),
}));

import { newGuestToken } from "@/lib/food/guest-token";

let order: Record<string, unknown> | null = null;
const updates: unknown[][] = [];
const q = async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FOR UPDATE OF lo")) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
  if (sql.includes("UPDATE local_orders")) {
    updates.push(params);
    return { rows: [{ id: params[0], order_number: "LO-1", status: params[1], updated_at: "now" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
};
vi.mock("@/lib/db", () => ({
  dbQuery: async (sql: string) => (sql.includes("FROM couriers") ? { rows: [{ id: "courier-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }),
  withTransaction: async (fn: (qq: typeof q) => Promise<unknown>) => fn(q),
}));

import { PATCH as statusPATCH } from "@/app/api/local-orders/[id]/status/route";
import { POST as cancelPOST } from "@/app/api/local-orders/[id]/cancel/route";
import { POST as suggestPOST } from "@/app/api/merchants/[id]/suggest/route";

const OID = "66666666-6666-4666-8666-666666666666";
const ctx = { params: Promise.resolve({ id: OID }) };
const guest = newGuestToken();
const baseOrder = {
  id: OID, status: "placed", courier_id: null, customer_user_id: null, guest_token_hash: guest.hash, order_number: "LO-1",
  payment_method: "card_online", payment_status: "paid", seller_id: "seller-1", merchant_name: "Bistro",
};
const patch = (body: unknown) => new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (headers: Record<string, string> = {}) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  sessionUser = null;
  sellerId = "seller-1";
  rlOk = true;
  order = { ...baseOrder };
});

describe("PATCH /api/local-orders/[id]/status", () => {
  it("lets the owning restaurant reject and runs refund effects", async () => {
    const res = await statusPATCH(patch({ status: "rejected", reason: "Închidem mai devreme" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).refund_status).toBe("succeeded");
    expect(updates[0]).toEqual([OID, "rejected", "Închidem mai devreme", "merchant"]);
    expect(effects).toHaveBeenCalledWith(expect.objectContaining({ orderId: OID, status: "rejected" }));
  });

  it("refuses another seller's order", async () => {
    sellerId = "seller-2";
    const res = await statusPATCH(patch({ status: "accepted" }), ctx);
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it("refuses to accept an unpaid card order", async () => {
    order = { ...baseOrder, payment_status: "pending" };
    const res = await statusPATCH(patch({ status: "accepted" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("unpaid_card");
  });

  it("returns 409 invalid_transition for out-of-order moves", async () => {
    order = { ...baseOrder, status: "delivered" };
    const res = await statusPATCH(patch({ status: "preparing" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("invalid_transition");
  });

  it("lets only the assigned courier pick up", async () => {
    sessionUser = "courier-user";
    order = { ...baseOrder, status: "ready", courier_id: "courier-1" };
    expect((await statusPATCH(patch({ status: "picked_up" }), ctx)).status).toBe(200);
    order = { ...baseOrder, status: "ready", courier_id: "courier-9" };
    expect((await statusPATCH(patch({ status: "picked_up" }), ctx)).status).toBe(403);
  });
});

describe("POST /api/local-orders/[id]/cancel (customer)", () => {
  it("needs a session or a guest token", async () => {
    expect((await cancelPOST(post(), ctx)).status).toBe(401);
  });

  it("cancels a placed order with the guest token (no push to the customer)", async () => {
    const res = await cancelPOST(post({ "x-order-token": guest.token }), ctx);
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual([OID, "cancelled", null, "customer"]);
    expect(effects).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", notifyCustomer: false }));
  });

  it("hides orders the caller can't access (404, not 403)", async () => {
    const res = await cancelPOST(post({ "x-order-token": newGuestToken().token }), ctx);
    expect(res.status).toBe(404);
  });

  it("refuses once the restaurant has accepted", async () => {
    sessionUser = "user-1";
    order = { ...baseOrder, status: "accepted", customer_user_id: "user-1" };
    const res = await cancelPOST(post(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("invalid_transition");
  });
});

describe("POST /api/merchants/[id]/suggest", () => {
  it("counts a suggestion for an unclaimed merchant", async () => {
    suggestMerchant.mockResolvedValue({ ok: true, counted: true, count: 5 });
    const res = await suggestPOST(post(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).suggestion_count).toBe(5);
    expect(suggestMerchant.mock.calls[0][1]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses partner (orderable) merchants", async () => {
    suggestMerchant.mockResolvedValue({ ok: false, code: "not_claimable" });
    expect((await suggestPOST(post(), ctx)).status).toBe(409);
  });
  it("is rate limited", async () => {
    rlOk = false;
    expect((await suggestPOST(post(), ctx)).status).toBe(429);
    expect(suggestMerchant).not.toHaveBeenCalled();
  });
});
