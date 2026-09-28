/**
 * Plata unei rezervări 'pending' → 'requested' (bani ținuți, gazda decide).
 *
 * Card (principal): PaymentIntent cu capture_method=manual — banii sunt doar
 *   autorizați; capture la acceptul gazdei, cancel la refuz/expirare. Clientul
 *   confirmă în Payment Element, apoi apelează confirm-card (sync verificat la
 *   Stripe); webhook-ul payment_intent.amount_capturable_updated e plasa de
 *   siguranță.
 * Wallet (secundar): suma se debitează acum și se rambursează la refuz.
 */
import type Stripe from "stripe";
import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { debitUserTx, InsufficientFundsError } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import type { Q } from "./booking";
import { loadBooking, type BookingRow } from "./bookings-repo";
import { staysConfig } from "./config";
import { StaysError } from "./errors";
import { voidCardHold } from "./money";
import { notifyHostNewRequest } from "./notifications";

const db: Q = (text, params) => dbQuery(text, params ?? []);

function assertOwnPending(b: BookingRow | null, userId: string): BookingRow {
    if (!b || b.guest_user_id !== userId) throw new StaysError("not_found");
    if (b.status !== "pending" || (b.expires_at && Date.parse(b.expires_at) <= Date.now())) {
        throw new StaysError("bad_state");
    }
    return b;
}

async function ownPendingBooking(bookingId: string, userId: string): Promise<BookingRow> {
    return assertOwnPending(await loadBooking(db, bookingId), userId);
}

/** UPDATE-ul atomic pending → requested, pe conexiunea dată (tranzacție sau pool). */
async function transitionToRequested(q: Q, bookingId: string, method: "card" | "wallet"): Promise<boolean> {
    const { rows } = await q<{ id: string }>(
        `UPDATE stay_bookings
            SET status = 'requested', payment_status = 'authorized', payment_method = $2,
                requested_at = now(), updated_at = now(),
                expires_at = now() + ($3::int * interval '1 hour')
          WHERE id = $1::uuid AND status = 'pending'
          RETURNING id::text`,
        [bookingId, method, staysConfig.hostResponseTtlHours()],
    );
    return rows.length > 0;
}

function announceRequested(bookingId: string, method: "card" | "wallet"): void {
    logger.info({ bookingId, method }, "stays: booking requested (payment held)");
    void notifyHostNewRequest(bookingId);
}

/** pending → requested (o singură dată); notifică gazda. */
export async function markRequested(bookingId: string, method: "card" | "wallet"): Promise<boolean> {
    if (!(await transitionToRequested(db, bookingId, method))) return false;
    announceRequested(bookingId, method);
    return true;
}

const REUSABLE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation", "requires_action"];

/** Creează (sau refolosește) hold-ul pe card. */
export async function startCardPayment(bookingId: string, userId: string): Promise<{ clientSecret: string; amountCents: number }> {
    const b = await ownPendingBooking(bookingId, userId);
    if (!Number.isInteger(b.total_cents) || b.total_cents < staysConfig.minCardAmountCents()) {
        throw new StaysError("amount_too_small");
    }
    if (!process.env.STRIPE_SECRET_KEY) throw new StaysError("card_unavailable");
    const stripe = getStripe();

    if (b.stripe_payment_intent_id) {
        const existing = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id).catch(() => null);
        if (existing && REUSABLE.includes(existing.status) && existing.amount === b.total_cents && existing.client_secret) {
            return { clientSecret: existing.client_secret, amountCents: b.total_cents };
        }
    }

    const intent = await stripe.paymentIntents.create(
        {
            amount: b.total_cents,
            currency: (b.currency || "RON").toLowerCase(),
            capture_method: "manual",
            payment_method_types: ["card"],
            metadata: { kind: "stay_booking", stay_booking_id: b.id, user_id: userId },
            description: `Swypik Stays ${b.id}`,
        },
        // Include PI-ul anterior (anulat de o încercare wallet / expirat): altfel Stripe
        // ar întoarce același PaymentIntent anulat pentru aceeași cheie.
        { idempotencyKey: `stay:${b.id}:authorize:${b.total_cents}:${b.stripe_payment_intent_id ?? "first"}` },
    );
    await dbQuery(
        `UPDATE stay_bookings SET stripe_payment_intent_id = $2, payment_method = 'card', updated_at = now()
          WHERE id = $1::uuid`,
        [b.id, intent.id],
    );
    if (!intent.client_secret) throw new StaysError("payment_failed");
    return { clientSecret: intent.client_secret, amountCents: b.total_cents };
}

/**
 * Verifică la Stripe că plata e autorizată și trece rezervarea în 'requested'.
 * Idempotent; apelat de client după confirmPayment și de webhook.
 * Dacă între timp rezervarea a expirat/anulat, hold-ul e eliberat.
 */
export async function syncCardAuthorization(bookingId: string, userId?: string): Promise<{ status: string }> {
    const b = await loadBooking(db, bookingId);
    if (!b || (userId && b.guest_user_id !== userId)) throw new StaysError("not_found");
    if (!b.stripe_payment_intent_id) throw new StaysError("payment_not_authorized");
    if (b.status === "requested" || b.status === "confirmed") {
        // Deja plătită altfel (wallet) → hold-ul pe card nu trebuie să rămână blocat.
        if (b.payment_method !== "card") await voidCardHold(b.id, b.stripe_payment_intent_id).catch(() => undefined);
        return { status: b.status };
    }

    const pi = await getStripe().paymentIntents.retrieve(b.stripe_payment_intent_id);
    if (pi.metadata?.stay_booking_id !== b.id || pi.status !== "requires_capture" || pi.amount !== b.total_cents) {
        throw new StaysError("payment_not_authorized");
    }
    if (b.status !== "pending" || !(await markRequested(b.id, "card"))) {
        // Autorizare venită după expirare/anulare: nu ținem banii clientului.
        await voidCardHold(b.id, pi.id).catch(() => undefined);
        throw new StaysError("bad_state");
    }
    return { status: "requested" };
}

/**
 * Plata din wallet: debit acum, refund automat la refuz/expirare.
 *
 * Debitul și tranziția pending → requested se fac în ACEEAȘI tranzacție, cu
 * rândul rezervării blocat (FOR UPDATE): două apeluri paralele se serializează,
 * al doilea vede 'requested' și iese fără să debiteze sau să ramburseze
 * (înainte, perdantul rambursa debitul câștigătorului → sejur gratuit).
 */
export async function payWithWallet(bookingId: string, userId: string): Promise<{ status: string }> {
    const b = await ownPendingBooking(bookingId, userId);
    // Un PaymentIntent început anterior nu trebuie să mai poată fi autorizat.
    await voidCardHold(b.id, b.stripe_payment_intent_id).catch(() => undefined);
    try {
        await withTransaction(async (q: TxQuery) => {
            const locked = assertOwnPending(await loadBooking(q, bookingId, true), userId);
            const refunded = await q<{ id: string }>(
                `SELECT id::text FROM wallet_ledger_entries WHERE ref_type = 'stay_refund' AND ref_id = $1 AND kind = 'credit' LIMIT 1`,
                [locked.id],
            );
            // Un debit vechi deja rambursat nu poate fi „refolosit” (idempotența ledger-ului ar sări debitul).
            if (refunded.rows.length) throw new StaysError("payment_failed");
            await debitUserTx(q, {
                userId,
                amountCents: locked.total_cents,
                refType: "stay_booking",
                refId: locked.id,
                description: `stay_booking ${locked.title}`,
            });
            // Sub lock, rândul e încă 'pending' — dacă totuși nu, ROLLBACK anulează și debitul.
            if (!(await transitionToRequested(q, locked.id, "wallet"))) throw new StaysError("bad_state");
        });
    } catch (err) {
        if (err instanceof StaysError) throw err;
        if (err instanceof InsufficientFundsError) throw new StaysError("insufficient_funds");
        logger.error({ err, bookingId }, "stays: wallet debit failed");
        throw new StaysError("payment_failed");
    }
    announceRequested(bookingId, "wallet");
    return { status: "requested" };
}
