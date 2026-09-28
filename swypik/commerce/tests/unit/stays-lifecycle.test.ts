import { beforeEach, describe, expect, it, vi } from "vitest";

const queries: string[] = [];
let expiredPending: { id: string; stripe_payment_intent_id: string | null }[] = [];
let expiredRequests: { id: string }[] = [];
let completed: { id: string }[] = [];
let retryRelease: { id: string }[] = [];
const bookings: Record<string, Record<string, unknown>> = {};

vi.mock("@/lib/db", () => ({
    dbQuery: async (sql: string, params: unknown[] = []) => {
        queries.push(sql);
        if (sql.includes("WHERE status = 'pending' AND expires_at <= now()")) return { rows: expiredPending };
        if (sql.includes("WHERE status = 'requested' AND decided_at IS NULL AND expires_at <= now()")) return { rows: expiredRequests };
        if (sql.includes("SET status = 'completed'")) return { rows: completed };
        if (sql.includes("WHERE status = 'expired' AND payment_status = 'authorized'")) return { rows: retryRelease };
        if (sql.includes("JOIN marketplace_products")) return { rows: [bookings[params[0] as string]] };
        if (sql.includes("SET payment_status = $2")) {
            Object.assign(bookings[params[0] as string], { payment_status: params[1], refund_cents: params[2] });
            return { rows: [] };
        }
        return { rows: [] };
    },
    withTransaction: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const notifyGuestDeclined = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/stays/notifications", () => ({ notifyGuestDeclined: (...a: unknown[]) => notifyGuestDeclined(...a) }));
const credit = vi.fn(async (_a: unknown) => ({ alreadyApplied: false }));
vi.mock("@/lib/wallet/ledger", () => ({ creditUser: (a: unknown) => credit(a), debitUser: vi.fn() }));
const stripe = { paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() } };
vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => stripe }));

import { runStaysLifecycle } from "@/lib/stays/lifecycle";

beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    expiredPending = [];
    expiredRequests = [];
    completed = [];
    retryRelease = [];
});

describe("stays lifecycle cron", () => {
    it("expires unpaid pending holds (freeing the calendar) and voids a leftover card intent", async () => {
        expiredPending = [
            { id: "b-1", stripe_payment_intent_id: "pi_1" },
            { id: "b-2", stripe_payment_intent_id: null },
        ];
        stripe.paymentIntents.retrieve.mockResolvedValue({ status: "requires_payment_method" });
        const r = await runStaysLifecycle();
        expect(r.expiredPending).toBe(2);
        expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
        expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { idempotencyKey: "stay:b-1:void" });
    });

    it("releases the money of requests the host never answered", async () => {
        expiredRequests = [{ id: "b-3" }];
        bookings["b-3"] = {
            id: "b-3", guest_user_id: "g", host_user_id: "h", total_cents: 30000, payment_method: "wallet",
            stripe_payment_intent_id: null, title: "Cabana", status: "expired", payment_status: "authorized",
        };
        const r = await runStaysLifecycle();
        expect(r.expiredRequests).toBe(1);
        expect(credit).toHaveBeenCalledWith(expect.objectContaining({ userId: "g", amountCents: 30000, refType: "stay_refund", refId: "b-3" }));
        expect(bookings["b-3"]).toMatchObject({ payment_status: "refunded", refund_cents: 30000 });
        expect(notifyGuestDeclined).toHaveBeenCalledWith("b-3", "expired");
    });

    it("retries the release of an already-expired request whose refund failed on a previous run", async () => {
        retryRelease = [{ id: "b-4" }];
        bookings["b-4"] = {
            id: "b-4", guest_user_id: "g", host_user_id: "h", total_cents: 1000, payment_method: "wallet",
            stripe_payment_intent_id: null, title: "Cabana", status: "expired", payment_status: "authorized",
        };
        const r = await runStaysLifecycle();
        expect(r.expiredRequests).toBe(1);
        expect(credit).toHaveBeenCalledWith(expect.objectContaining({ refType: "stay_refund", refId: "b-4" }));
        expect(bookings["b-4"].payment_status).toBe("refunded");
        // Nu re-notifică oaspetele pentru o expirare deja anunțată.
        expect(notifyGuestDeclined).not.toHaveBeenCalled();
        // A doua rulare: nimic de eliberat (idempotent).
        retryRelease = [];
        credit.mockClear();
        await runStaysLifecycle();
        expect(credit).not.toHaveBeenCalled();
    });

    it("never expires a request the host already claimed (decided_at set)", async () => {
        await runStaysLifecycle();
        const q = queries.find((s) => s.includes("status = 'requested'"))!;
        expect(q).toContain("decided_at IS NULL");
    });

    it("marks finished stays as completed", async () => {
        completed = [{ id: "b-9" }];
        const r = await runStaysLifecycle();
        expect(r.completed).toBe(1);
        expect(queries.some((s) => s.includes("check_out <= CURRENT_DATE"))).toBe(true);
    });
});
