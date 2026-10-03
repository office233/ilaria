/**
 * Procesarea idempotentă a plăților de deblocare (Movies + Music).
 *
 * `media_unlock_payments.payment_intent_id` e cheie primară: prima livrare a
 * webhook-ului pentru un PaymentIntent îl „revendică", orice retry Stripe e
 * no-op. Dacă deblocarea era deja plătită cu ALT PaymentIntent (două tab-uri,
 * retry după schimbarea prețului), plata duplicată se rambursează automat —
 * userul nu plătește niciodată de două ori pentru același acces.
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { logger } from "@/lib/logger";

export type UnlockVertical = "movies" | "music";
export type UnlockPaymentOutcome = "granted" | "duplicate_refunded" | "duplicate_refund_failed" | "unknown_unlock";

/**
 * true = PaymentIntent-ul trebuie procesat (prima livrare, sau o livrare
 * anterioară a căzut înainte să înregistreze un rezultat); false = deja
 * procesat complet (retry Stripe → no-op).
 */
export async function claimUnlockPayment(args: {
    paymentIntentId: string;
    vertical: UnlockVertical;
    unlockId: string | null;
    amountCents: number;
}): Promise<boolean> {
    const { rows } = await dbQuery<{ payment_intent_id: string }>(
        `INSERT INTO media_unlock_payments (payment_intent_id, vertical, unlock_id, amount_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (payment_intent_id) DO UPDATE SET updated_at = now()
            WHERE media_unlock_payments.outcome = 'processing'
         RETURNING payment_intent_id`,
        [args.paymentIntentId, args.vertical, args.unlockId, args.amountCents],
    );
    return rows.length > 0;
}

export async function recordUnlockPaymentOutcome(paymentIntentId: string, outcome: UnlockPaymentOutcome): Promise<void> {
    await dbQuery(
        `UPDATE media_unlock_payments SET outcome = $2, updated_at = now() WHERE payment_intent_id = $1`,
        [paymentIntentId, outcome],
    );
}

/** A fost vreodată o plată de deblocare? (refund-urile ei nu mai trec prin fluxul de comenzi). */
export async function isKnownUnlockPayment(paymentIntentId: string): Promise<boolean> {
    const { rows } = await dbQuery(`SELECT 1 FROM media_unlock_payments WHERE payment_intent_id = $1`, [paymentIntentId]);
    return rows.length > 0;
}

/**
 * Plata a sosit pentru o deblocare deja plătită: rambursare integrală
 * (idempotentă pe cheia Stripe) și înregistrarea rezultatului.
 */
export async function refundDuplicateUnlockPayment(args: {
    paymentIntentId: string;
    vertical: UnlockVertical;
    unlockId: string | null;
}): Promise<UnlockPaymentOutcome> {
    try {
        await getStripe().refunds.create(
            { payment_intent: args.paymentIntentId, reason: "duplicate", metadata: { kind: `${args.vertical}_unlock_duplicate`, unlockId: args.unlockId ?? "" } },
            { idempotencyKey: `unlock_duplicate_refund:${args.paymentIntentId}` },
        );
        logger.warn({ ...args }, "[unlock] duplicate payment for an already-paid unlock — refunded");
        await recordUnlockPaymentOutcome(args.paymentIntentId, "duplicate_refunded");
        return "duplicate_refunded";
    } catch (err) {
        logger.error({ err, ...args }, "[unlock] duplicate payment refund FAILED — manual refund needed");
        await recordUnlockPaymentOutcome(args.paymentIntentId, "duplicate_refund_failed");
        return "duplicate_refund_failed";
    }
}

/**
 * Nu s-a putut marca nimic plătit. Starea curentă a rândului decide:
 * - plătit chiar cu ACEST PaymentIntent (livrare concurentă) → acces deja dat;
 * - plătit cu alt PaymentIntent → plată duplicată, rambursăm;
 * - niciun rând → PaymentIntent necunoscut, nu dăm acces.
 */
export async function settleUnmatchedUnlockPayment(args: {
    paymentIntentId: string;
    vertical: UnlockVertical;
    unlockId: string | null;
    current: { status: string; payment_intent_id: string | null } | null;
}): Promise<UnlockPaymentOutcome> {
    const { current, ...ids } = args;
    if (current?.status === "paid" && current.payment_intent_id === args.paymentIntentId) {
        await recordUnlockPaymentOutcome(args.paymentIntentId, "granted");
        return "granted";
    }
    if (current?.status === "paid") return refundDuplicateUnlockPayment(ids);
    logger.error({ ...args }, "[unlock] payment does not match any unlock — not granted");
    await recordUnlockPaymentOutcome(args.paymentIntentId, "unknown_unlock");
    return "unknown_unlock";
}
