import { describe, it, expect, vi, beforeEach } from "vitest";

/** w2-food: rambursarea comenzilor Food anulate/refuzate (Stripe + stornare ledger). */

vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});

const stripe = {
  paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
  refunds: { create: vi.fn() },
};
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => stripe }));

const creditUser = vi.fn(async (_a: unknown) => ({ alreadyApplied: false, entry: {} }));
const debitUser = vi.fn(async (_a: unknown) => ({ alreadyApplied: false, entry: {} }));
vi.mock("@/lib/wallet/ledger", () => ({ creditUser: (a: unknown) => creditUser(a), debitUser: (a: unknown) => debitUser(a) }));

let orderRow: Record<string, unknown> | null = null;
let ledgerRows: Record<string, unknown>[] = [];
const dbQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("FROM local_orders WHERE id")) return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
  if (sql.includes("FROM wallet_ledger_entries")) return { rows: ledgerRows, rowCount: ledgerRows.length };
  return { rows: [], rowCount: 1 };
});
vi.mock("@/lib/db", () => ({ dbQuery: (s: string, p?: unknown[]) => dbQuery(s, p) }));

import { refundLocalOrder } from "@/lib/food/refund";

const ID = "33333333-3333-4333-8333-333333333333";
const base = { id: ID, status: "cancelled", payment_method: "card_online", payment_status: "paid", payment_intent_id: "pi_1", refund_status: "none", settled_at: null };

function lastRefundUpdate(): unknown[] | undefined {
  const call = [...dbQuery.mock.calls].reverse().find(([sql]) => String(sql).includes("SET refund_status"));
  return call?.[1] as unknown[] | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  orderRow = { ...base };
  ledgerRows = [];
});

describe("refundLocalOrder", () => {
  it("refunds a paid card order through Stripe, idempotently per order", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    stripe.refunds.create.mockResolvedValue({ id: "re_1", status: "succeeded", amount: 4500 });
    const r = await refundLocalOrder(ID, "rejected");
    expect(r).toMatchObject({ status: "succeeded", refundId: "re_1", amountCents: 4500 });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_1" }),
      { idempotencyKey: `local_order:${ID}:refund` },
    );
    expect(lastRefundUpdate()).toEqual([ID, "succeeded", "re_1", 4500, "refunded"]);
  });

  it("cancels an unconfirmed PaymentIntent instead of refunding", async () => {
    orderRow = { ...base, payment_status: "pending" };
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
    const r = await refundLocalOrder(ID, "customer_cancelled");
    expect(r.status).toBe("not_required");
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("marks a processing payment as pending (the webhook refunds it later)", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "processing" });
    expect((await refundLocalOrder(ID, "x")).status).toBe("pending");
  });

  it("needs no refund for cash orders", async () => {
    orderRow = { ...base, payment_method: "cash", payment_intent_id: null };
    expect((await refundLocalOrder(ID, "x")).status).toBe("not_required");
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("does nothing for orders that are not cancelled/rejected", async () => {
    orderRow = { ...base, status: "delivered" };
    expect((await refundLocalOrder(ID, "x")).status).toBe("not_required");
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("is a no-op when already refunded", async () => {
    orderRow = { ...base, refund_status: "succeeded" };
    expect((await refundLocalOrder(ID, "x")).status).toBe("succeeded");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("records a failure (and a reconciliation issue) when Stripe errors", async () => {
    stripe.paymentIntents.retrieve.mockRejectedValue(Object.assign(new Error("boom"), { code: "api_error" }));
    const r = await refundLocalOrder(ID, "x");
    expect(r.status).toBe("failed");
    expect(dbQuery.mock.calls.some(([sql]) => String(sql).includes("reconciliation_issues"))).toBe(true);
  });

  it("reverses the wallet ledger of an already-settled order", async () => {
    orderRow = { ...base, payment_method: "cash", payment_intent_id: null, settled_at: "2026-09-25" };
    ledgerRows = [
      { user_id: "courier-1", kind: "debit", amount_cents: "3000", ref_type: "order" },
      { user_id: "platform", kind: "credit", amount_cents: "600", ref_type: "commission_order" },
    ];
    const r = await refundLocalOrder(ID, "x");
    expect(r.ledgerReversed).toBe(2);
    expect(creditUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "courier-1", amountCents: 3000, refType: "order_reversal", refId: ID }));
    expect(debitUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "platform", amountCents: 600, refType: "commission_order_reversal", allowNegative: true }));
  });
});
