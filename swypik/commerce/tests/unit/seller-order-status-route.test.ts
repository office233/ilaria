import { describe, it, expect, vi, beforeEach } from "vitest";

const ORDER_ID = "33333333-3333-4333-8333-333333333333";
type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let orderRow: Record<string, unknown> | null;
let cancelRow: { pi: string | null; others: number; seller_shipped?: number; seller_open_cents: number } | null;
const refundsCreate = vi.fn();

function baseOrder(status: string, items: Array<{ source_status: string; metadata?: Record<string, string> }>) {
  return {
    order_id: ORDER_ID,
    order_status: status,
    order_meta: {},
    currency: "RON",
    created_at: "2026-09-20T10:00:00Z",
    total_cents: 5000,
    items: items.map((i, n) => ({ item_id: `it${n}`, title: "Tricou", quantity: 1, unit_amount_cents: 5000, metadata: i.metadata ?? {}, source_status: i.source_status })),
  };
}

function respond(sql: string, params: unknown[]) {
  calls.push({ sql, params });
  if (sql.includes("WITH m AS")) return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
  if (sql.includes("AS seller_open_cents")) return { rows: cancelRow ? [cancelRow] : [], rowCount: 1 };
  if (sql.includes("RETURNING product_id::text")) return { rows: [{ product_id: "p1", variant_id: null, quantity: 2 }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

vi.mock("@/lib/db", () => {
  const q = vi.fn(async (sql: string, params: unknown[] = []) => respond(sql, params));
  return { dbQuery: q, withTransaction: async <T,>(fn: (tx: typeof q) => Promise<T>) => fn(q) };
});
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => "seller-1" }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 5 }) }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => false }));
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("@/lib/creator/commission", () => ({ reverseCreatorCommissionsForItems: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/seller/orders/[id]/status/route";

const act = (action: string, id = ORDER_ID) =>
  POST(new Request(`http://x/api/seller/orders/${id}/status`, { method: "POST", body: JSON.stringify({ action }) }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  calls = [];
  orderRow = baseOrder("paid", [{ source_status: "pending_seller_action" }]);
  cancelRow = { pi: "pi_1", others: 0, seller_open_cents: 5000 };
  refundsCreate.mockReset();
  refundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded", amount: 5000, currency: "ron" });
});

describe("POST /api/seller/orders/[id]/status", () => {
  it("validare: id invalid → 400, acțiune necunoscută → 400, 'ship' merge pe /awb", async () => {
    expect((await act("accept", "x")).status).toBe(400);
    expect((await act("explode")).status).toBe(400);
    expect((await act("ship")).status).toBe(400);
  });

  it("comanda altui seller → 404", async () => {
    orderRow = null;
    const res = await act("accept");
    expect(res.status).toBe(404);
  });

  it("new → accept: marchează seller_accepted_at doar pe item-urile seller-ului", async () => {
    const res = await act("accept");
    expect(await res.json()).toMatchObject({ success: true, state: "accepted" });
    const upd = calls.find((c) => c.sql.trim().startsWith("UPDATE") && c.sql.includes("'seller_accepted_at'"));
    expect(upd?.params).toEqual([ORDER_ID, "seller-1"]);
  });

  it("tranziție invalidă (livrare înainte de expediere) → 409, nicio scriere", async () => {
    const res = await act("deliver");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("invalid_transition");
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("comandă neplătită → nicio acțiune", async () => {
    orderRow = baseOrder("pending", [{ source_status: "pending_seller_action" }]);
    expect((await act("accept")).status).toBe(409);
  });

  it("shipped → deliver: delivered_at pe item-uri + comanda 'delivered' când totul a ajuns", async () => {
    orderRow = baseOrder("fulfilled", [{ source_status: "fulfilled" }]);
    const res = await act("deliver");
    expect(await res.json()).toMatchObject({ success: true, state: "delivered" });
    expect(calls.some((c) => c.sql.trim().startsWith("UPDATE") && c.sql.includes("'delivered_at'"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("SET status = 'delivered'"))).toBe(true);
  });

  it("expediat → cancel refuzat (409)", async () => {
    orderRow = baseOrder("fulfilled", [{ source_status: "fulfilled" }]);
    expect((await act("cancel")).status).toBe(409);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("cancel (singurul seller) → refund Stripe TOTAL, item-uri anulate, stoc înapoi, payout oprit", async () => {
    const res = await act("cancel");
    expect(await res.json()).toMatchObject({ success: true, state: "cancelled", refundId: "re_1" });
    const [args, opts] = refundsCreate.mock.calls[0];
    expect(args).toEqual(expect.objectContaining({ payment_intent: "pi_1" }));
    expect(args).not.toHaveProperty("amount");
    expect(opts).toEqual({ idempotencyKey: `seller-cancel-${ORDER_ID}-seller-1` });
    expect(calls.some((c) => c.sql.includes("SET source_status = 'cancelled'"))).toBe(true);
    const restock = calls.find((c) => c.sql.includes("'{available_stock}'"));
    expect(restock?.params).toEqual(["p1", 2]);
    expect(calls.some((c) => c.sql.includes("'seller_payout_status', 'refunded'"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO payment_transactions"))).toBe(true);
  });

  it("cancel într-o comandă multi-seller → refund PARȚIAL = item-urile seller-ului", async () => {
    cancelRow = { pi: "pi_1", others: 2, seller_open_cents: 3500 };
    await act("cancel");
    expect(refundsCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ amount: 3500 }));
  });

  it("cancel single-seller cu o parte deja expediată → refund DOAR item-urile neexpediate", async () => {
    cancelRow = { pi: "pi_1", others: 0, seller_shipped: 1, seller_open_cents: 2000 };
    await act("cancel");
    expect(refundsCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ amount: 2000 }));
  });

  it("fără PaymentIntent → 409 missing_payment_intent; eșec Stripe → 502, fără scrieri", async () => {
    cancelRow = { pi: null, others: 0, seller_open_cents: 5000 };
    const r1 = await act("cancel");
    expect(r1.status).toBe(409);
    cancelRow = { pi: "pi_1", others: 0, seller_open_cents: 5000 };
    refundsCreate.mockRejectedValue(Object.assign(new Error("boom"), { code: "charge_already_refunded" }));
    calls = [];
    const r2 = await act("cancel");
    expect(r2.status).toBe(502);
    expect(await r2.json()).toMatchObject({ error: "stripe_refund_failed", code: "charge_already_refunded" });
    expect(calls.some((c) => c.sql.includes("SET source_status = 'cancelled'"))).toBe(false);
  });
});
