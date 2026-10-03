/**
 * FRONT R5 — Stripe pentru comenzi Eats (local_orders).
 *
 * createLocalOrderPaymentIntent: PaymentIntent pe totalul comenzii (calculat
 * server-side la plasare) → client_secret pentru Stripe Payment Element.
 * capture_method=manual (audit food-go #7): cardul e doar AUTORIZAT la plasare;
 * banii se încasează abia când restaurantul acceptă comanda (lib/food/card-payment),
 * iar la refuz / anulare / timeout hold-ul se eliberează (lib/food/refund).
 *
 * Confirmarea vine prin webhook (payment_intent.succeeded cu
 * metadata.kind='local_order') → payment_status='paid'. Decontarea în ledger
 * se face la 'delivered' (settleLocalOrder), nu la plată — banii se împart
 * doar după ce livrarea chiar s-a întâmplat.
 */
import { getStripe } from "@/lib/stripe/checkout";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { refundLocalOrder } from "@/lib/food/refund";

const log = logger.child({ mod: "payments/eats-stripe" });

export async function createLocalOrderPaymentIntent(orderId: string): Promise<{
    payment_intent_id: string;
    client_secret: string | null;
    amount_cents: number;
} | null> {
    const { rows } = await dbQuery<{
        id: string;
        total_cents: number;
        currency: string;
        payment_method: string;
        payment_status: string;
        payment_intent_id: string | null;
        customer_user_id: string | null;
    }>(
        `SELECT id, total_cents::int AS total_cents, currency, payment_method,
            payment_status, payment_intent_id, customer_user_id
       FROM local_orders WHERE id = $1`,
        [orderId],
    );
    const order = rows[0];
    if (!order) return null;
    if (order.payment_method !== "card_online") {
        throw new Error("Comanda nu e cu plata card online.");
    }
    if (order.payment_status === "paid") {
        throw new Error("Comanda e deja plătită.");
    }
    if (order.total_cents <= 0) throw new Error("Comanda are total zero.");

    const stripe = getStripe();

    // Refolosește PI existent dacă e încă utilizabil (retry de confirmare în UI).
    if (order.payment_intent_id) {
        const existing = await stripe.paymentIntents.retrieve(order.payment_intent_id);
        if (
            ["requires_payment_method", "requires_confirmation", "requires_action", "processing"].includes(
                existing.status,
            )
        ) {
            return {
                payment_intent_id: existing.id,
                client_secret: existing.client_secret,
                amount_cents: existing.amount,
            };
        }
    }

    const pi = await stripe.paymentIntents.create(
        {
            amount: order.total_cents,
            currency: (order.currency || "ron").toLowerCase(),
            metadata: {
                kind: "local_order",
                local_order_id: order.id,
                customer_user_id: order.customer_user_id ?? "",
            },
            description: `Swypik Eats order ${order.id}`,
            capture_method: "manual",
        },
        { idempotencyKey: `local_order:${order.id}:pi-manual` },
    );

    await dbQuery(
        `UPDATE local_orders SET payment_intent_id = $2, updated_at = now() WHERE id = $1`,
        [order.id, pi.id],
    );
    log.info({ orderId, pi: pi.id, amount: order.total_cents }, "local order PI created");
    return { payment_intent_id: pi.id, client_secret: pi.client_secret, amount_cents: order.total_cents };
}

/** Webhook: payment_intent.succeeded pentru o comandă Eats. Idempotent. */
export async function markLocalOrderPaid(localOrderId: string, paymentIntentId: string): Promise<boolean> {
    const { rows, rowCount } = await dbQuery<{ status: string }>(
        `UPDATE local_orders
        SET payment_status = 'paid', payment_intent_id = COALESCE(payment_intent_id, $2), updated_at = now()
      WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')
      RETURNING status`,
        [localOrderId, paymentIntentId],
    );
    if (rowCount) log.info({ localOrderId, paymentIntentId }, "local order marked paid");
    // Plata a ajuns după ce comanda fusese anulată/refuzată (ex. PaymentIntent
    // „processing" la momentul anulării) → banii se întorc imediat.
    const status = rows[0]?.status;
    if (status === "cancelled" || status === "rejected") {
        await refundLocalOrder(localOrderId, "paid_after_cancel");
    }
    return Boolean(rowCount);
}

/** Webhook: payment_intent.payment_failed pentru o comandă Eats. */
export async function markLocalOrderPaymentFailed(localOrderId: string): Promise<void> {
    await dbQuery(
        `UPDATE local_orders SET payment_status = 'failed', updated_at = now()
      WHERE id = $1 AND payment_status = 'pending'`,
        [localOrderId],
    );
}
