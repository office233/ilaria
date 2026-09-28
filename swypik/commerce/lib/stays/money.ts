/**
 * Mișcările de bani Stays, idempotente:
 *  - creditHost: netul gazdei în wallet (ledger stay_payout) la confirmare
 *  - releaseHold: eliberează plata AUTORIZATĂ (card: cancel PI; wallet: refund)
 *  - refundPaid: refund după capture (card → Stripe, la metoda originală;
 *    wallet → ledger) + retragerea proporțională de la gazdă
 */
import { dbQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { creditUser, debitUser } from "@/lib/wallet/ledger";
import { logger } from "@/lib/logger";
import { commissionPct } from "./config";
import { hostClawbackCents, splitCommission } from "./policy";
import type { BookingRow } from "./bookings-repo";

type MoneyBooking = Pick<
    BookingRow,
    "id" | "guest_user_id" | "host_user_id" | "total_cents" | "payment_method" | "stripe_payment_intent_id" | "title"
>;

export async function creditHost(b: MoneyBooking): Promise<void> {
    if (!b.host_user_id) return;
    const pct = commissionPct();
    const { hostNetCents } = splitCommission(b.total_cents, pct);
    if (hostNetCents <= 0) return;
    try {
        await creditUser({
            userId: b.host_user_id,
            amountCents: hostNetCents,
            refType: "stay_payout",
            refId: b.id,
            description: `stay_payout ${b.title}`,
            metadata: { commission_pct: pct },
        });
    } catch (err) {
        logger.error({ err, bookingId: b.id }, "stays: host credit failed — reconciliation issue");
        await dbQuery(
            `INSERT INTO reconciliation_issues (kind, ref_id, details)
             VALUES ('stay_host_credit_failed', $1, $2)
             ON CONFLICT (kind, ref_id) WHERE resolved = false DO NOTHING`,
            [b.id, JSON.stringify({ host_user_id: b.host_user_id, amount_cents: hostNetCents })],
        ).catch((e) => logger.error({ err: e }, "stays: reconciliation insert failed"));
    }
}

/** Anulează PaymentIntent-ul (hold) — no-op dacă e deja anulat/inexistent. */
export async function voidCardHold(bookingId: string, intentId: string | null): Promise<void> {
    if (!intentId) return;
    try {
        const stripe = getStripe();
        const pi = await stripe.paymentIntents.retrieve(intentId);
        if (pi.status === "canceled" || pi.status === "succeeded") return;
        await stripe.paymentIntents.cancel(intentId, undefined, { idempotencyKey: `stay:${bookingId}:void` });
    } catch (err) {
        logger.error({ err, bookingId, intentId }, "stays: void card hold failed");
        throw err;
    }
}

/** Eliberează o plată autorizată dar necapturată (refuz, expirare, anulare 'requested'). */
export async function releaseHold(b: MoneyBooking): Promise<{ paymentStatus: "voided" | "refunded"; refundCents: number }> {
    if (b.payment_method === "wallet") {
        if (b.guest_user_id && b.total_cents > 0) {
            await creditUser({
                userId: b.guest_user_id,
                amountCents: b.total_cents,
                refType: "stay_refund",
                refId: b.id,
                description: `stay_refund ${b.title}`,
            });
        }
        return { paymentStatus: "refunded", refundCents: b.total_cents };
    }
    await voidCardHold(b.id, b.stripe_payment_intent_id);
    return { paymentStatus: "voided", refundCents: 0 };
}

/** Refund după capture + clawback proporțional de la gazdă. */
export async function refundPaid(
    b: MoneyBooking,
    refundCents: number,
): Promise<{ paymentStatus: "refunded" | "partially_refunded" | "paid" }> {
    if (refundCents <= 0) return { paymentStatus: "paid" };
    if (b.payment_method === "card" && b.stripe_payment_intent_id) {
        await getStripe().refunds.create(
            { payment_intent: b.stripe_payment_intent_id, amount: refundCents, metadata: { kind: "stay_booking", stay_booking_id: b.id } },
            { idempotencyKey: `stay:${b.id}:refund:${refundCents}` },
        );
    } else if (b.guest_user_id) {
        await creditUser({
            userId: b.guest_user_id,
            amountCents: refundCents,
            refType: "stay_refund",
            refId: b.id,
            description: `stay_refund ${b.title}`,
        });
    }
    const clawback = hostClawbackCents(b.total_cents, refundCents, commissionPct());
    if (b.host_user_id && clawback > 0) {
        await debitUser({
            userId: b.host_user_id,
            amountCents: clawback,
            refType: "stay_refund_clawback",
            refId: b.id,
            description: `stay_refund_clawback ${b.title}`,
            allowNegative: true,
        }).catch((err) => logger.error({ err, bookingId: b.id }, "stays: host clawback failed — recover manually"));
    }
    return { paymentStatus: refundCents >= b.total_cents ? "refunded" : "partially_refunded" };
}
