/**
 * Anulări Stays (client sau gazdă) cu refund conform politicii (policy.ts):
 *  - 'pending'   → nimic plătit; hold-ul de card rămas (dacă există) e anulat
 *  - 'requested' → plata doar autorizată: hold eliberat integral
 *  - 'confirmed' → refund: gazda 100%; clientul 100% cu ≥ N zile înainte,
 *                  altfel STAYS_LATE_CANCEL_REFUND_PCT; card → Stripe (metoda
 *                  originală), wallet → ledger; gazdei i se retrage partea ei.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Q } from "./booking";
import { loadBooking, relationTo } from "./bookings-repo";
import { freeCancelDays, lateCancelRefundPct } from "./config";
import { todayIso } from "./dates";
import { StaysError } from "./errors";
import { refundPaid, releaseHold, voidCardHold } from "./money";
import { notifyCancellation } from "./notifications";
import { guestCanCancel, refundFor } from "./policy";

const db: Q = (text, params) => dbQuery(text, params ?? []);

export type CancelResult = { refundCents: number; refundPct: number; cancelledBy: "guest" | "host" };

export async function cancelBooking(bookingId: string, userId: string, now: Date = new Date()): Promise<CancelResult> {
    const b = await loadBooking(db, bookingId);
    const rel = b ? relationTo(b, userId) : null;
    if (!b || !rel) throw new StaysError("not_found");

    const today = todayIso(now);
    const allowed =
        rel === "guest"
            ? guestCanCancel(b.status, b.check_in, today)
            : ["requested", "confirmed"].includes(b.status) && b.check_in >= today;
    if (!allowed) throw new StaysError("bad_state");

    // Tranziție atomică; o cerere 'requested' deja revendicată de gazdă (accept în curs) nu se anulează.
    const { rows } = await dbQuery<{ id: string }>(
        `UPDATE stay_bookings
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, expires_at = NULL, updated_at = now()
          WHERE id = $1::uuid AND status = $3
            AND (status <> 'requested' OR decided_at IS NULL)
          RETURNING id::text`,
        [b.id, rel, b.status],
    );
    if (!rows.length) throw new StaysError("bad_state");

    let refundCents = 0;
    let refundPct = 0;
    let paymentStatus: string = b.payment_status;
    if (b.status === "pending") {
        await voidCardHold(b.id, b.stripe_payment_intent_id).catch(() => undefined);
        paymentStatus = b.stripe_payment_intent_id ? "voided" : b.payment_status;
    } else if (b.status === "requested") {
        const released = await releaseHold(b);
        refundCents = released.refundCents;
        refundPct = 100;
        paymentStatus = released.paymentStatus;
    } else if (b.payment_status === "paid") {
        const decision = refundFor({
            totalCents: b.total_cents,
            checkIn: b.check_in,
            now,
            by: rel,
            freeDays: freeCancelDays(),
            latePct: lateCancelRefundPct(),
        });
        const refunded = await refundPaid(b, decision.refundCents);
        refundCents = decision.refundCents;
        refundPct = decision.refundPct;
        paymentStatus = refunded.paymentStatus;
    }

    await dbQuery(
        `UPDATE stay_bookings SET payment_status = $2, refund_cents = $3, updated_at = now() WHERE id = $1::uuid`,
        [b.id, paymentStatus, refundCents],
    );
    logger.info({ bookingId, by: rel, refundCents, refundPct }, "stays: booking cancelled");
    void notifyCancellation(b.id, rel);
    return { refundCents, refundPct, cancelledBy: rel };
}

/** Previzualizarea refundului (pentru dialogul de confirmare din UI). */
export function previewGuestRefund(b: { status: string; total_cents: number; check_in: string }, now: Date = new Date()) {
    if (b.status === "requested") return { refundPct: 100, refundCents: b.total_cents };
    if (b.status !== "confirmed") return { refundPct: 0, refundCents: 0 };
    return refundFor({
        totalCents: b.total_cents,
        checkIn: b.check_in,
        now,
        by: "guest",
        freeDays: freeCancelDays(),
        latePct: lateCancelRefundPct(),
    });
}
