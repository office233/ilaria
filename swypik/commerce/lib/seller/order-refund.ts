/**
 * Rambursarea item-urilor unui seller dintr-o comandă Stripe — comună pentru:
 *  - `return`: seller-ul aprobă un retur (comandă single-seller, refund total,
 *    comanda → 'refunded'); rută: /api/seller/orders/[id]/refund (FEATURE_RETURNS);
 *  - `cancel`: seller-ul anulează înainte de expediere (refund total dacă deține
 *    toate item-urile rămase, altfel parțial = valoarea item-urilor lui);
 *    item-urile → 'cancelled', stocul revine; rută: /api/seller/orders/[id]/status.
 *
 * Banii pleacă întâi de la Stripe (idempotent), apoi toate consecințele în DB
 * într-o singură tranzacție: payout seller oprit (sau marcat pentru clawback
 * dacă era deja plătit), comisioane creator retrase, payment_transactions.
 */
import { withTransaction, type TxQuery } from "@/lib/db";
import { getStripe } from "@/lib/stripe/checkout";
import { reverseCreatorCommissionsForItems } from "@/lib/creator/commission";
import { logger } from "@/lib/logger";

export type SellerRefundMode = "return" | "cancel";

export type StripeRefundOutcome =
  | { ok: true; refundId: string; status: string; amountCents: number; currency: string }
  | { ok: false; code: string };

/** Payout-uri de seller încă neplătite → pot fi oprite fără clawback. */
const SELLER_UNPAID = ["pending", "no_account", "restricted", "failed", "requested"];
const CREATOR_UNPAID = ["pending", "not_connected", "no_account", "restricted", "failed"];

export async function createSellerStripeRefund(args: {
  orderId: string;
  sellerId: string;
  paymentIntentId: string;
  amountCents: number | null;
  mode: SellerRefundMode;
}): Promise<StripeRefundOutcome> {
  try {
    const refund = await getStripe().refunds.create(
      {
        payment_intent: args.paymentIntentId,
        ...(args.amountCents != null ? { amount: args.amountCents } : {}),
        metadata: {
          order_id: args.orderId,
          seller_id: args.sellerId,
          reason: args.mode === "return" ? "seller_approved_return" : "seller_cancelled",
        },
      },
      {
        idempotencyKey:
          args.mode === "return" ? `seller-refund-${args.orderId}` : `seller-cancel-${args.orderId}-${args.sellerId}`,
      },
    );
    return {
      ok: true,
      refundId: refund.id,
      status: refund.status || "pending",
      amountCents: refund.amount || 0,
      currency: String(refund.currency || "ron").toUpperCase(),
    };
  } catch (err) {
    logger.error({ err, orderId: args.orderId }, "[seller/refund] Stripe refund failed");
    // Nu expunem mesajul brut Stripe; doar codul.
    const code =
      typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "stripe_error";
    return { ok: false, code };
  }
}

type Clawback = { id: string; amount_cents: number | null; transfer_id: string | null; creator_id?: string | null };

async function cancelItemsAndRestock(q: TxQuery, orderId: string, sellerId: string): Promise<void> {
  const { rows } = await q<{ product_id: string | null; variant_id: string | null; quantity: number }>(
    `UPDATE commerce_order_items
        SET source_status = 'cancelled',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_by_seller_at', NOW()::text)
      WHERE order_id = $1::uuid AND metadata->>'seller_id' = $2 AND source_status NOT IN ('fulfilled', 'cancelled')
      RETURNING product_id::text, variant_id::text, quantity`,
    [orderId, sellerId],
  );
  for (const r of rows) {
    if (r.variant_id) {
      await q(
        `UPDATE marketplace_product_variants SET inventory_quantity = inventory_quantity + $2, updated_at = now()
          WHERE id = $1::uuid AND inventory_quantity IS NOT NULL`,
        [r.variant_id, r.quantity],
      );
    } else if (r.product_id) {
      await q(
        `UPDATE marketplace_products
            SET metadata = jsonb_set(metadata, '{available_stock}',
                  to_jsonb(COALESCE(NULLIF(metadata->>'available_stock', '')::int, 0) + $2), true),
                updated_at = now()
          WHERE id = $1::uuid AND metadata ? 'available_stock'`,
        [r.product_id, r.quantity],
      );
    }
  }
}

/** Consecințele în DB după un refund Stripe reușit (atomic). */
export async function applySellerRefund(args: {
  orderId: string;
  sellerId: string;
  paymentIntentId: string;
  mode: SellerRefundMode;
  refund: Extract<StripeRefundOutcome, { ok: true }>;
}): Promise<void> {
  const { orderId, sellerId, refund } = args;
  const { sellerClawback, creatorClawback } = await withTransaction(async (q) => {
    if (args.mode === "cancel") await cancelItemsAndRestock(q, orderId, sellerId);

    const stamp = JSON.stringify({
      refund_id: refund.refundId,
      refund_status: refund.status,
      ...(args.mode === "return"
        ? { refunded_at: new Date().toISOString(), refunded_by_seller: sellerId, return_status: "refunded" }
        : { cancelled_by_seller: sellerId, seller_cancel_refund_cents: refund.amountCents }),
    });
    await q(
      `UPDATE commerce_orders
          SET metadata = metadata || $2::jsonb,
              status = CASE
                WHEN $3::text = 'return' THEN 'refunded'
                WHEN NOT EXISTS (SELECT 1 FROM commerce_order_items i WHERE i.order_id = $1::uuid AND i.source_status <> 'cancelled')
                  THEN 'cancelled'
                ELSE status END,
              cancelled_at = CASE WHEN $3::text = 'cancel' AND NOT EXISTS (
                SELECT 1 FROM commerce_order_items i WHERE i.order_id = $1::uuid AND i.source_status <> 'cancelled')
                THEN now() ELSE cancelled_at END
        WHERE id = $1::uuid`,
      [orderId, stamp, args.mode],
    );

    // Doar item-urile afectate: la retur toate ale seller-ului, la anulare cele anulate acum.
    const scope = args.mode === "return" ? "" : "AND source_status = 'cancelled'";
    const { rows: sellerClawback } = await q<Clawback>(
      `UPDATE commerce_order_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'refunded_after_seller_payout', true, 'refunded_after_seller_payout_at', NOW()::text, 'refund_id', $3::text)
        WHERE order_id = $1::uuid AND metadata->>'seller_id' = $2 ${scope}
          AND metadata->>'seller_payout_status' = 'paid'
        RETURNING id, NULLIF(metadata->>'seller_payout_cents','')::int AS amount_cents, metadata->>'seller_transfer_id' AS transfer_id`,
      [orderId, sellerId, refund.refundId],
    );
    await q(
      `UPDATE commerce_order_items
          SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'seller_payout_request_id') || jsonb_build_object(
                'seller_payout_status', 'refunded', 'seller_payout_refunded_at', NOW()::text, 'refund_id', $3::text)
        WHERE order_id = $1::uuid AND metadata->>'seller_id' = $2 ${scope}
          AND (metadata->>'seller_payout_status' IS NULL OR metadata->>'seller_payout_status' = ANY($4::text[]))`,
      [orderId, sellerId, refund.refundId, SELLER_UNPAID],
    );
    const { rows: creatorClawback } = await q<Clawback>(
      `UPDATE commerce_order_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'refunded_after_creator_payout', true, 'refunded_after_creator_payout_at', NOW()::text)
        WHERE order_id = $1::uuid AND metadata->>'seller_id' = $2 ${scope}
          AND payout_status = 'paid' AND creator_id IS NOT NULL
        RETURNING id, commissionable_amount_cents AS amount_cents,
                  metadata->>'creator_transfer_id' AS transfer_id, creator_id::text AS creator_id`,
      [orderId, sellerId],
    );
    await q(
      `UPDATE commerce_order_items SET payout_status = 'refunded'
        WHERE order_id = $1::uuid AND metadata->>'seller_id' = $2 ${scope}
          AND (payout_status IS NULL OR payout_status = ANY($3::text[]))`,
      [orderId, sellerId, CREATOR_UNPAID],
    );
    await q(
      `INSERT INTO payment_transactions (
         order_id, provider, provider_payment_id, transaction_type, status, currency, amount_cents, processed_at, metadata
       ) VALUES ($1, 'stripe', $2, 'refund', $3, $4, $5, now(), $6::jsonb)
       ON CONFLICT (provider, provider_payment_id, transaction_type)
       DO UPDATE SET status = EXCLUDED.status, processed_at = EXCLUDED.processed_at,
                     metadata = payment_transactions.metadata || EXCLUDED.metadata`,
      [
        orderId,
        refund.refundId,
        refund.status === "succeeded" ? "succeeded" : "pending",
        refund.currency,
        refund.amountCents,
        JSON.stringify({ payment_intent: args.paymentIntentId, seller_id: sellerId, mode: args.mode }),
      ],
    );
    return { sellerClawback, creatorClawback };
  });

  // După commit: alerte de reconciliere + retragerea comisioanelor creatorilor.
  for (const row of sellerClawback) {
    logger.error(
      { order_id: orderId, item_id: row.id, seller_id: sellerId, amount_cents: row.amount_cents, transfer_id: row.transfer_id, refund_id: refund.refundId },
      "[refund-after-payout] seller payout already settled - manual clawback required",
    );
  }
  await reverseCreatorCommissionsForItems(creatorClawback.map((r) => r.id), "seller_refund").catch((err) =>
    logger.error({ err, order_id: orderId }, "[seller/refund] creator commission reversal failed"),
  );
}
