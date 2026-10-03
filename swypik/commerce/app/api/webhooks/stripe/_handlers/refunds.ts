import type Stripe from "stripe";
import { dbQuery } from "@/lib/db";
import { sendRefundEmail } from "@/lib/email/service";
import { logger } from "@/lib/logger";
import { revokeCreatorUnlockForPayment } from "./creator-unlocks";
import { reverseCreatorCommissionsForPaymentIntent } from "@/lib/creator/commission";

export async function handleChargeRefunded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (pi) {
    // CRITIC (audit 2026-08-25): un refund PARȚIAL (ex. 20 RON dintr-o comandă
    // de 300, acordat din Dashboard pentru un singur item defect) marca TOATĂ
    // comanda `refunded` — stare terminală care oprea payout-urile celorlalți
    // selleri și anula itemele încă nelivrate.
    // Distingem parțial de total după suma refundată vs suma încasată.
    const isFullRefund =
      typeof charge.amount === "number" && charge.amount > 0
        ? (charge.amount_refunded || 0) >= charge.amount
        : true; // fără sumă cunoscută, tratăm conservator ca refund total
    const orderStatus = isFullRefund ? "refunded" : "partially_refunded";

    // Deblocări Movies/Music plătite cu cardul: un refund TOTAL revocă accesul
    // și retrage cota creatorului; unul parțial păstrează accesul.
    if (isFullRefund && (await revokeCreatorUnlockForPayment(pi, "refund"))) {
      return;
    }

    await dbQuery(
      `UPDATE commerce_orders
          SET status = $2,
              metadata = metadata || jsonb_build_object(
                'refund_amount_cents', $3::int,
                'last_refund_event_id', $4::text,
                'last_refund_at', now()::text
              )
        WHERE metadata->>'paymentIntentId' = $1
           OR metadata->>'payment_intent_id' = $1
           OR metadata->>'stripe_payment_intent' = $1`,
      [pi, orderStatus, charge.amount_refunded || 0, event.id]
    );

    // Comisioanele de creator deja creditate în portofel se retrag la refund total.
    if (isFullRefund) {
      await reverseCreatorCommissionsForPaymentIntent(pi, "charge_refunded").catch((err) =>
        logger.error({ err, pi }, "[webhook] creator commission reversal failed"),
      );
    }

    // Itemele se anulează DOAR la refund total. La refund parțial (bunăvoință
    // pentru un singur produs) restul comenzii se onorează normal, iar
    // payout-urile celorlalți selleri nu se blochează.
    if (isFullRefund) {
      await dbQuery(
        `UPDATE commerce_order_items coi
         SET
           source_status = CASE
             WHEN coi.source_status IN ('pending', 'pending_dropship', 'pending_seller_action')
               THEN 'cancelled'
             ELSE coi.source_status
           END,
           metadata = coi.metadata || jsonb_build_object(
             'refund_event_id', $2::text,
             'refunded_at', now()::text,
             'refund_amount_cents', $3::int
           )
         FROM commerce_orders co
         WHERE coi.order_id = co.id
           AND (co.metadata->>'paymentIntentId' = $1
                OR co.metadata->>'payment_intent_id' = $1
                OR co.metadata->>'stripe_payment_intent' = $1)`,
        [pi, event.id, charge.amount_refunded || 0]
      );
    }

    try {
      const { rows: oRows } = await dbQuery<{ id: string; currency: string; total_cents: number; customer_email: string | null; user_email: string | null }>(
        `SELECT co.id, co.currency, co.total_cents,
                (co.metadata->>'customer_email') AS customer_email,
                u.email AS user_email
           FROM commerce_orders co
           LEFT JOIN users u ON u.id = co.buyer_user_id
          WHERE co.metadata->>'paymentIntentId' = $1
             OR co.metadata->>'payment_intent_id' = $1
             OR co.metadata->>'stripe_payment_intent' = $1
          LIMIT 1`,
        [pi]
      );
      const order = oRows[0];
      if (order) {
        const toEmail = order.customer_email || order.user_email;
        const amountCents = typeof charge.amount_refunded === "number" && charge.amount_refunded > 0
          ? charge.amount_refunded
          : (order.total_cents || 0);
        if (toEmail) {
          await sendRefundEmail(toEmail, order.id, amountCents, order.currency || "RON").catch((err) =>
            logger.warn({ err }, "[refund-email]")
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "[refund-email] lookup failed");
    }
  }
}

export async function handleIntentDead(event: Stripe.Event) {
  // `event.data.object` e o uniune peste toate obiectele Stripe. Toate au `id`,
  // dar TypeScript nu poate demonstra asta pe o uniune atât de largă. Îngustăm
  // la exact ce citim, în loc să dezactivăm verificarea cu `as any`.
  const objId = (event.data.object as { id: string }).id;
  await dbQuery(
    "UPDATE commerce_orders SET status='cancelled', metadata = metadata || jsonb_build_object('cancelled_at', NOW()::text, 'cancelled_event', $2::text) WHERE metadata->>'paymentIntentId' = $1 OR metadata->>'payment_intent_id' = $1 OR metadata->>'sessionId' = $1 OR metadata->>'stripe_session_id' = $1 OR metadata->>'stripe_payment_intent' = $1",
    [objId, event.type]
  );
  // Anulează itemele încă neprocesate ale comenzii anulate.
  await dbQuery(
    `UPDATE commerce_order_items coi
     SET source_status = 'cancelled',
         metadata = coi.metadata || jsonb_build_object('cancelled_event', $2::text, 'cancelled_at', NOW()::text)
     FROM commerce_orders co
     WHERE coi.order_id = co.id
       AND coi.source_status IN ('pending', 'pending_dropship', 'pending_seller_action')
       AND (co.metadata->>'paymentIntentId' = $1
            OR co.metadata->>'payment_intent_id' = $1
            OR co.metadata->>'sessionId' = $1
            OR co.metadata->>'stripe_session_id' = $1
            OR co.metadata->>'stripe_payment_intent' = $1)`,
    [objId, event.type]
  );
}
