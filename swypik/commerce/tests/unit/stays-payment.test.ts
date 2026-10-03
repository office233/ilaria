import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB în memorie: o singură rezervare, tranzițiile de stare evaluate pe SQL ──
type Booking = Record<string, unknown>;
let booking: Booking;
const sqls: string[] = [];

function bookingRow() {
    return { ...booking, title: "Casa", image_url: null, location_city: "Brașov" };
}

let refundExists = false;

async function dbQuery(sql: string, params: unknown[] = []) {
    sqls.push(sql);
    if (sql.includes("ref_type = 'stay_refund'")) return { rows: refundExists ? [{ id: "e1" }] : [], rowCount: refundExists ? 1 : 0 };
    const one = (ok: boolean) => ({ rows: ok ? [{ id: booking.id }] : [], rowCount: ok ? 1 : 0 });
    if (sql.includes("FROM stay_bookings b") && sql.includes("JOIN marketplace_products")) return { rows: [bookingRow()], rowCount: 1 };
    if (sql.includes("SET status = 'requested'")) {
        const ok = booking.status === "pending";
        if (ok) Object.assign(booking, { status: "requested", payment_status: "authorized", payment_method: params[1] });
        return one(ok);
    }
    if (sql.includes("SET decided_at = now(), expires_at = NULL")) {
        const ok = booking.status === "requested" && !booking.decided_at;
        if (ok) booking.decided_at = "now";
        return one(ok);
    }
    if (sql.includes("SET status = 'confirmed'")) {
        const ok = booking.status === "requested";
        if (ok) Object.assign(booking, { status: "confirmed", payment_status: "paid" });
        return one(ok);
    }
    if (sql.includes("SET status = 'declined'")) {
        const ok = booking.status === "requested" && !booking.decided_at;
        if (ok) booking.status = "declined";
        return one(ok);
    }
    if (sql.includes("SET status = 'cancelled'")) {
        const ok = booking.status === params[2];
        if (ok) booking.status = "cancelled";
        return one(ok);
    }
    if (sql.includes("SET payment_status = $2, refund_cents = $3")) {
        Object.assign(booking, { payment_status: params[1], refund_cents: params[2] });
        return one(true);
    }
    if (sql.includes("SET stripe_payment_intent_id")) {
        Object.assign(booking, { stripe_payment_intent_id: params[1], payment_method: "card" });
        return one(true);
    }
    return { rows: [], rowCount: 0 };
}
// Tranzacția rulează pe același DB în memorie, serializată (ca lock-ul FOR UPDATE pe rând);
// un ROLLBACK restaurează rezervarea.
let txChain: Promise<unknown> = Promise.resolve();
vi.mock("@/lib/db", () => ({
    dbQuery: (s: string, p: unknown[]) => dbQuery(s, p),
    withTransaction: (fn: (q: typeof dbQuery) => Promise<unknown>) => {
        const run = txChain.then(async () => {
            const snapshot = { ...booking };
            try {
                return await fn((s, p) => dbQuery(s, p ?? []));
            } catch (err) {
                booking = snapshot;
                throw err;
            }
        });
        txChain = run.catch(() => undefined);
        return run;
    },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stays/notifications", () => ({
    notifyHostNewRequest: vi.fn(async () => {}),
    notifyGuestBookingConfirmed: vi.fn(async () => {}),
    notifyGuestDeclined: vi.fn(async () => {}),
    notifyCancellation: vi.fn(async () => {}),
}));

const ledger = { credit: vi.fn(), debit: vi.fn() };
const { InsufficientFundsError } = vi.hoisted(() => ({ InsufficientFundsError: class InsufficientFundsError extends Error {} }));
vi.mock("@/lib/wallet/ledger", () => ({
    creditUser: (a: unknown) => ledger.credit(a),
    debitUser: (a: unknown) => ledger.debit(a),
    debitUserTx: (_q: unknown, a: unknown) => ledger.debit(a),
    InsufficientFundsError,
}));

const stripe = {
    paymentIntents: { create: vi.fn(), retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
    refunds: { create: vi.fn() },
};
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => stripe }));

import { cancelBooking } from "@/lib/stays/cancellation";
import { acceptBooking, declineBooking } from "@/lib/stays/host-decisions";
import { payWithWallet, startCardPayment, syncCardAuthorization } from "@/lib/stays/payment";

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
    vi.clearAllMocks();
    sqls.length = 0;
    refundExists = false;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    booking = {
        id: "b-1",
        product_id: "p-1",
        guest_user_id: "guest-1",
        host_user_id: "host-1",
        guest_name: "Ana",
        check_in: future(20),
        check_out: future(22),
        guests_count: 2,
        total_cents: 40000,
        currency: "RON",
        status: "pending",
        payment_status: "pending",
        payment_method: null,
        stripe_payment_intent_id: null,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        refund_cents: 0,
        decided_at: null,
    };
    ledger.credit.mockResolvedValue({ alreadyApplied: false });
    ledger.debit.mockResolvedValue({ alreadyApplied: false });
});

describe("card payment (hold → capture)", () => {
    it("creates a manual-capture PaymentIntent for the guest's pending booking", async () => {
        stripe.paymentIntents.create.mockResolvedValue({ id: "pi_1", client_secret: "cs_1" });
        const r = await startCardPayment("b-1", "guest-1");
        expect(r).toEqual({ clientSecret: "cs_1", amountCents: 40000 });
        const [params, opts] = stripe.paymentIntents.create.mock.calls[0];
        expect(params).toMatchObject({ amount: 40000, currency: "ron", capture_method: "manual", payment_method_types: ["card"] });
        expect(params.metadata).toMatchObject({ kind: "stay_booking", stay_booking_id: "b-1" });
        expect(opts.idempotencyKey).toBe("stay:b-1:authorize:40000:first");
        expect(booking.stripe_payment_intent_id).toBe("pi_1");
    });

    it("refuses other users and expired holds", async () => {
        await expect(startCardPayment("b-1", "intruder")).rejects.toMatchObject({ code: "not_found" });
        booking.expires_at = new Date(Date.now() - 1000).toISOString();
        await expect(startCardPayment("b-1", "guest-1")).rejects.toMatchObject({ code: "bad_state" });
    });

    it("moves to 'requested' only after Stripe confirms requires_capture", async () => {
        booking.stripe_payment_intent_id = "pi_1";
        stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method", amount: 40000, metadata: { stay_booking_id: "b-1" } });
        await expect(syncCardAuthorization("b-1", "guest-1")).rejects.toMatchObject({ code: "payment_not_authorized" });
        expect(booking.status).toBe("pending");

        stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount: 40000, metadata: { stay_booking_id: "b-1" } });
        await expect(syncCardAuthorization("b-1", "guest-1")).resolves.toEqual({ status: "requested" });
        expect(booking).toMatchObject({ status: "requested", payment_status: "authorized", payment_method: "card" });
    });

    it("host accept captures the card, confirms and credits the host net of commission", async () => {
        Object.assign(booking, { status: "requested", payment_status: "authorized", payment_method: "card", stripe_payment_intent_id: "pi_1" });
        stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture" });
        await expect(acceptBooking("b-1", "host-1")).resolves.toEqual({ status: "confirmed" });
        expect(stripe.paymentIntents.capture).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: "stay:b-1:capture" });
        expect(booking.status).toBe("confirmed");
        expect(ledger.credit).toHaveBeenCalledWith(expect.objectContaining({ userId: "host-1", amountCents: 36000, refType: "stay_payout", refId: "b-1" }));
    });

    it("host decline voids the hold (no charge, no host credit)", async () => {
        Object.assign(booking, { status: "requested", payment_status: "authorized", payment_method: "card", stripe_payment_intent_id: "pi_1" });
        stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture" });
        await declineBooking("b-1", "host-1", "Renovări");
        expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { idempotencyKey: "stay:b-1:void" });
        expect(booking).toMatchObject({ status: "declined", payment_status: "voided", refund_cents: 0 });
        expect(ledger.credit).not.toHaveBeenCalled();
    });

    it("refuses to accept (and capture) once the check-in date has passed", async () => {
        Object.assign(booking, { status: "requested", payment_method: "card", stripe_payment_intent_id: "pi_1", check_in: future(-1) });
        await expect(acceptBooking("b-1", "host-1")).rejects.toMatchObject({ code: "bad_state" });
        expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    });

    it("only the listing's host can decide", async () => {
        booking.status = "requested";
        await expect(acceptBooking("b-1", "someone-else")).rejects.toMatchObject({ code: "not_found" });
    });
});

describe("wallet payment", () => {
    it("debits the wallet and moves to 'requested'", async () => {
        await expect(payWithWallet("b-1", "guest-1")).resolves.toEqual({ status: "requested" });
        expect(ledger.debit).toHaveBeenCalledWith(expect.objectContaining({ userId: "guest-1", amountCents: 40000, refType: "stay_booking" }));
        expect(booking.payment_method).toBe("wallet");
    });

    it("a retry after a voided intent gets a fresh idempotency key (not the canceled PI)", async () => {
        booking.stripe_payment_intent_id = "pi_old";
        stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_old", status: "canceled", amount: 40000 });
        stripe.paymentIntents.create.mockResolvedValue({ id: "pi_2", client_secret: "cs_2" });
        await startCardPayment("b-1", "guest-1");
        expect(stripe.paymentIntents.create.mock.calls[0][1].idempotencyKey).toBe("stay:b-1:authorize:40000:pi_old");
    });

    it("locks the booking row and debits + marks requested in one transaction", async () => {
        await payWithWallet("b-1", "guest-1");
        expect(sqls.some((q) => q.includes("FOR UPDATE OF b"))).toBe(true);
    });

    it("two parallel wallet payments: one debit, no refund, booking stays paid (no free stay)", async () => {
        const results = await Promise.allSettled([payWithWallet("b-1", "guest-1"), payWithWallet("b-1", "guest-1")]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "bad_state" } });
        expect(ledger.debit).toHaveBeenCalledTimes(1);
        expect(ledger.credit).not.toHaveBeenCalled();
        expect(booking).toMatchObject({ status: "requested", payment_method: "wallet" });
    });

    it("refuses to reuse a debit that was already refunded", async () => {
        refundExists = true;
        await expect(payWithWallet("b-1", "guest-1")).rejects.toMatchObject({ code: "payment_failed" });
        expect(ledger.debit).not.toHaveBeenCalled();
        expect(booking.status).toBe("pending");
    });

    it("maps insufficient funds to a stable code", async () => {
        ledger.debit.mockRejectedValue(new InsufficientFundsError("no"));
        await expect(payWithWallet("b-1", "guest-1")).rejects.toMatchObject({ code: "insufficient_funds" });
        expect(booking.status).toBe("pending");
    });

    it("declined wallet requests are refunded to the wallet", async () => {
        Object.assign(booking, { status: "requested", payment_status: "authorized", payment_method: "wallet" });
        await declineBooking("b-1", "host-1", null);
        expect(ledger.credit).toHaveBeenCalledWith(expect.objectContaining({ userId: "guest-1", amountCents: 40000, refType: "stay_refund" }));
        expect(booking).toMatchObject({ status: "declined", payment_status: "refunded", refund_cents: 40000 });
    });
});

describe("cancellation + refunds", () => {
    it("late guest cancellation refunds the policy % to the card and claws back the host share", async () => {
        Object.assign(booking, { status: "confirmed", payment_status: "paid", payment_method: "card", stripe_payment_intent_id: "pi_1", check_in: future(2) });
        const r = await cancelBooking("b-1", "guest-1");
        expect(r).toEqual({ refundCents: 20000, refundPct: 50, cancelledBy: "guest" });
        expect(stripe.refunds.create).toHaveBeenCalledWith(
            expect.objectContaining({ payment_intent: "pi_1", amount: 20000 }),
            { idempotencyKey: "stay:b-1:refund:20000" },
        );
expect(ledger.debit).toHaveBeenCalledWith(expect.objectContaining({ userId: "host-1", amountCents: 18000, refType: "stay_refund_clawback", negativeBalanceReason: "refund_clawback" }));
        expect(booking).toMatchObject({ status: "cancelled", payment_status: "partially_refunded", refund_cents: 20000 });
    });

    it("early wallet cancellation refunds 100% through the ledger", async () => {
        Object.assign(booking, { status: "confirmed", payment_status: "paid", payment_method: "wallet" });
        const r = await cancelBooking("b-1", "guest-1");
        expect(r.refundPct).toBe(100);
        expect(ledger.credit).toHaveBeenCalledWith(expect.objectContaining({ userId: "guest-1", amountCents: 40000, refType: "stay_refund" }));
        expect(booking.payment_status).toBe("refunded");
    });

    it("host cancellation always refunds 100%", async () => {
        Object.assign(booking, { status: "confirmed", payment_status: "paid", payment_method: "card", stripe_payment_intent_id: "pi_1", check_in: future(1) });
        const r = await cancelBooking("b-1", "host-1");
        expect(r).toMatchObject({ refundPct: 100, cancelledBy: "host" });
        expect(ledger.debit).toHaveBeenCalledWith(expect.objectContaining({ userId: "host-1", amountCents: 36000 }));
    });

    it("cancelling an unpaid pending booking refunds nothing", async () => {
        const r = await cancelBooking("b-1", "guest-1");
        expect(r).toMatchObject({ refundCents: 0 });
        expect(stripe.refunds.create).not.toHaveBeenCalled();
        expect(ledger.credit).not.toHaveBeenCalled();
    });

    it("strangers and started stays cannot be cancelled", async () => {
        await expect(cancelBooking("b-1", "stranger")).rejects.toMatchObject({ code: "not_found" });
        Object.assign(booking, { status: "confirmed", payment_status: "paid", check_in: future(0) });
        await expect(cancelBooking("b-1", "guest-1")).rejects.toMatchObject({ code: "bad_state" });
    });
});
