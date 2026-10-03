/**
 * Decizia gazdei pe o cerere 'requested':
 *   accept → capture card (sau banii din wallet sunt deja la noi) → 'confirmed',
 *            payment 'paid', netul gazdei în wallet
 *   decline → hold eliberat (card: cancel PI; wallet: refund) → 'declined'
 *
 * Tranziția de stare se face atomic (UPDATE … WHERE status='requested'), deci
 * două click-uri sau accept+expirare concurente nu pot aplica ambele efecte.
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { logger } from "@/lib/logger";
import type { Q } from "./booking";
import { loadBooking, type BookingRow } from "./bookings-repo";
import { StaysError } from "./errors";
import { creditHost, releaseHold } from "./money";
import { notifyGuestBookingConfirmed, notifyGuestDeclined } from "./notifications";

const db: Q = (text, params) => dbQuery(text, params ?? []);

async function hostRequest(bookingId: string, hostUserId: string): Promise<BookingRow> {
    const b = await loadBooking(db, bookingId);
    if (!b || b.host_user_id !== hostUserId) throw new StaysError("not_found");
    return b;
}

/** Capturează hold-ul pe card; idempotent (PI deja 'succeeded' = ok). */
async function captureCard(b: BookingRow): Promise<void> {
    if (!b.stripe_payment_intent_id) throw new StaysError("payment_not_authorized");
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
    if (pi.status === "succeeded") return;
    if (pi.status !== "requires_capture") throw new StaysError("payment_not_authorized");
    await stripe.paymentIntents.capture(pi.id, {}, { idempotencyKey: `stay:${b.id}:capture` });
}

/** Finalizează confirmarea după ce banii sunt încasați (folosit și de webhook). */
export async function finalizeConfirmed(b: BookingRow): Promise<boolean> {
    const { rows } = await dbQuery<{ id: string }>(
        `UPDATE stay_bookings
            SET status = 'confirmed', payment_status = 'paid', decided_at = COALESCE(decided_at, now()),
                expires_at = NULL, updated_at = now()
          WHERE id = $1::uuid AND status = 'requested'
          RETURNING id::text`,
        [b.id],
    );
    if (!rows.length) return false;
    await creditHost(b);
    void notifyGuestBookingConfirmed(b.id);
    logger.info({ bookingId: b.id, method: b.payment_method }, "stays: booking confirmed");
    return true;
}

export async function acceptBooking(bookingId: string, hostUserId: string): Promise<{ status: string }> {
    const b = await hostRequest(bookingId, hostUserId);
    if (b.status === "confirmed") return { status: "confirmed" };
    if (b.status !== "requested") throw new StaysError("bad_state");
    // Check-in-ul a trecut: nu capturăm cardul pentru o noapte deja pierdută (cron-ul eliberează banii).
    if (b.check_in < new Date().toISOString().slice(0, 10)) throw new StaysError("bad_state");

    // Revendicare atomică: expires_at=NULL scoate cererea din raza cron-ului de
    // expirare și decided_at blochează un refuz concurent, înainte de capture.
    const claim = await dbQuery<{ id: string }>(
        `UPDATE stay_bookings SET decided_at = now(), expires_at = NULL, updated_at = now()
          WHERE id = $1::uuid AND status = 'requested' AND decided_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          RETURNING id::text`,
        [b.id],
    );
    if (!claim.rows.length) throw new StaysError("bad_state");

    if (b.payment_method === "card") {
        try {
            await captureCard(b);
        } catch (err) {
            // Capture eșuat → cererea redevine expirabilă (cron-ul eliberează hold-ul).
            await dbQuery(
                `UPDATE stay_bookings SET decided_at = NULL, expires_at = now(), updated_at = now()
                  WHERE id = $1::uuid AND status = 'requested'`,
                [b.id],
            );
            if (err instanceof StaysError) throw err;
            logger.error({ err, bookingId }, "stays: capture failed");
            throw new StaysError("payment_failed");
        }
    }
    await finalizeConfirmed(b);
    return { status: "confirmed" };
}

export async function declineBooking(bookingId: string, hostUserId: string, reason: string | null): Promise<{ status: string }> {
    const b = await hostRequest(bookingId, hostUserId);
    if (b.status === "declined") return { status: "declined" };
    const { rows } = await dbQuery<{ id: string }>(
        `UPDATE stay_bookings
            SET status = 'declined', decided_at = now(), decline_reason = $2, expires_at = NULL, updated_at = now()
          WHERE id = $1::uuid AND status = 'requested' AND decided_at IS NULL
          RETURNING id::text`,
        [b.id, reason],
    );
    if (!rows.length) throw new StaysError("bad_state");
    const released = await releaseHold(b);
    await dbQuery(
        `UPDATE stay_bookings SET payment_status = $2, refund_cents = $3, updated_at = now() WHERE id = $1::uuid`,
        [b.id, released.paymentStatus, released.refundCents],
    );
    void notifyGuestDeclined(b.id, "declined");
    logger.info({ bookingId }, "stays: booking declined by host");
    return { status: "declined" };
}
