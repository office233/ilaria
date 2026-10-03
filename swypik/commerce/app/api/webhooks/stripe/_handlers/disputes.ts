import type Stripe from "stripe";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { revokeCreatorUnlockForPayment } from "./creator-unlocks";

export async function handleDisputeEvent(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const piId = typeof dispute.payment_intent === "string"
    ? dispute.payment_intent
    : dispute.payment_intent?.id;

  // Dispută PIERDUTĂ pe o deblocare Movies/Music: banii s-au întors la client,
  // deci accesul și cota creatorului se retrag (idempotent).
  if (piId && dispute.status === "lost") {
    await revokeCreatorUnlockForPayment(piId, "dispute_lost");
  }

  let orderId: string | null = null;
  if (chargeId || piId) {
    const { rows } = await dbQuery<{ id: string }>(
      `SELECT id FROM commerce_orders
        WHERE metadata->>'chargeId' = $1
           OR metadata->>'charge_id' = $1
           OR metadata->>'paymentIntentId' = $2
           OR metadata->>'payment_intent_id' = $2
        LIMIT 1`,
      [chargeId || "", piId || ""],
    );
    orderId = rows[0]?.id || null;
  }

  const evidenceDueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
    : null;

  await dbQuery(
    `INSERT INTO stripe_disputes
       (dispute_id, charge_id, payment_intent_id, order_id, amount_cents, currency,
        reason, status, evidence_due_by, is_charge_refundable, metadata)
     VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9::timestamptz,$10,$11::jsonb)
     ON CONFLICT (dispute_id) DO UPDATE SET
       status              = EXCLUDED.status,
       reason              = EXCLUDED.reason,
       evidence_due_by     = EXCLUDED.evidence_due_by,
       is_charge_refundable= EXCLUDED.is_charge_refundable,
       amount_cents        = EXCLUDED.amount_cents,
       metadata            = EXCLUDED.metadata,
       updated_at          = now()`,
    [
      dispute.id,
      chargeId || "",
      piId || null,
      orderId,
      dispute.amount,
      dispute.currency,
      dispute.reason || null,
      dispute.status,
      evidenceDueBy,
      dispute.is_charge_refundable ?? true,
      JSON.stringify({ event_type: event.type, dispute }),
    ],
  );

  if (orderId) {
    let orderStatus: string | null = null;
    if (dispute.status === "lost") orderStatus = "disputed_lost";
    else if (dispute.status === "won") orderStatus = "disputed_won";
    else if (event.type === "charge.dispute.created") orderStatus = "disputed";

    if (orderStatus) {
      await dbQuery(
        `UPDATE commerce_orders SET status = $2 WHERE id = $1::uuid`,
        [orderId, orderStatus],
      );
    }
  }

  logger.warn(
    { disputeId: dispute.id, status: dispute.status, amount: dispute.amount, orderId, eventType: event.type },
    "[Stripe Webhook] Dispute event",
  );
}
