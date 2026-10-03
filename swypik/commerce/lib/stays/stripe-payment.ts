/**
 * Webhook Stripe pentru rezervările Stays (metadata.kind = "stay_booking").
 *
 *  - payment_intent.amount_capturable_updated → hold autorizat: 'pending' →
 *    'requested' (plasa de siguranță pentru confirm-card din client)
 *  - payment_intent.succeeded → captura s-a făcut (la acceptul gazdei):
 *    finalizează confirmarea dacă acceptul s-a întrerupt după capture; dacă
 *    rezervarea nu mai e validă, banii se returnează integral
 *  - payment_intent.payment_failed → payment_status 'failed' (plata se poate reîncerca)
 *
 * Toate idempotente (tranziții condiționate de status).
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { logger } from "@/lib/logger";
import type { Q } from "./booking";
import { loadBooking } from "./bookings-repo";
import { StaysError } from "./errors";
import { finalizeConfirmed } from "./host-decisions";
import { syncCardAuthorization } from "./payment";

const db: Q = (text, params) => dbQuery(text, params ?? []);

export async function markStayBookingAuthorized(bookingId: string): Promise<void> {
    try {
        await syncCardAuthorization(bookingId);
    } catch (err) {
        if (err instanceof StaysError) {
            logger.warn({ bookingId, code: err.code }, "stay webhook: authorization not applied");
            return;
        }
        throw err;
    }
}

export async function markStayBookingPaidByCard(bookingId: string): Promise<void> {
    const b = await loadBooking(db, bookingId);
    if (!b) {
        logger.error({ bookingId }, "stay webhook: booking not found");
        return;
    }
    if (b.status === "confirmed" || b.status === "completed") return;
    if (b.status === "requested") {
        await finalizeConfirmed(b);
        return;
    }
    // Capturat pentru o rezervare care nu mai e validă → refund integral.
    if (b.stripe_payment_intent_id && b.payment_status !== "refunded") {
        await getStripe().refunds.create(
            { payment_intent: b.stripe_payment_intent_id, metadata: { kind: "stay_booking", stay_booking_id: b.id } },
            { idempotencyKey: `stay:${b.id}:refund:orphan` },
        );
        await dbQuery(
            `UPDATE stay_bookings SET payment_status = 'refunded', refund_cents = total_cents, updated_at = now()
              WHERE id = $1::uuid`,
            [b.id],
        );
        logger.warn({ bookingId, status: b.status }, "stay webhook: captured for inactive booking — refunded");
    }
}

export async function markStayBookingCardFailed(bookingId: string): Promise<void> {
    await dbQuery(
        `UPDATE stay_bookings SET payment_status = 'failed', updated_at = now()
          WHERE id = $1::uuid AND status = 'pending' AND payment_status IN ('pending','failed')`,
        [bookingId],
    );
}
