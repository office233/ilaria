import type Stripe from "stripe";
import { dbQuery } from "@/lib/db";
import { routeOrder } from "@/lib/fulfillment/order-router";
import { logCheckoutEvent } from "@/lib/security/audit-log";
import { scoreOrderRisk } from "@/lib/risk/order-fraud-score";
import { notifyOps } from "@/lib/ops/alerts";
import { markLocalOrderPaid, markLocalOrderPaymentFailed } from "@/lib/payments/eats-stripe";
import { maybeAutoDispatch } from "@/lib/dispatch/auto";
import { settleRide } from "@/lib/payments/mobility";
import { attributeOrder } from "@/lib/algo/attribution";
import { logger } from "@/lib/logger";
import { onOrderPaid, onRidePaid, onLocalOrderPaid } from "@/lib/referral/validation";
import { markStayBookingPaidByCard, markStayBookingCardFailed } from "@/lib/stays/stripe-payment";
import { APP_URL } from "@/lib/app-url";
import { maybeSendOrderConfirmation } from "./shared";
import { finalizePaidShopOrder } from "@/lib/shop/order-paid";
import { FRAUD_REVIEW_SCORE, FRAUD_BLOCK_SCORE } from "@/lib/risk/thresholds";
import { markMissionFunded } from "@/lib/missions/funding";
import { awardMilestoneXp } from "@/lib/gaming/activity-xp";

export async function handlePaymentIntentSucceededEvent(event: Stripe.Event) {
  const intent = event.data.object as Stripe.PaymentIntent;
  // FRONT R5 — Eats: comenzi locale plătite cu Payment Element.
  if (intent.metadata?.kind === "local_order" && intent.metadata?.local_order_id) {
    await markLocalOrderPaid(intent.metadata.local_order_id, intent.id);
    // Referral: prima comandă Eats plătită validează atribuirea clientului.
    await onLocalOrderPaid(intent.metadata.local_order_id, intent.id);
    // Auto-dispatch pe 'placed' e acum blocat cât timp plata nu e confirmată
    // (lib/dispatch/auto.ts). Confirmarea e momentul în care comanda poate
    // porni — fără reluarea asta ar rămâne blocată la merchant.
    try {
      await maybeAutoDispatch(intent.metadata.local_order_id, "placed");
    } catch (err) {
      logger.error({ err, orderId: intent.metadata.local_order_id }, "[webhook] auto-dispatch după plată a eșuat");
    }
  } else if (intent.metadata?.kind === "ride" && intent.metadata?.ride_id) {
    // Go: succeeded vine la CAPTURE (mobility-stripe deja setează
    // payment_status='captured' sincron; aici doar plasa de siguranță).
    await dbQuery(
      `UPDATE rides SET payment_status = 'captured', updated_at = now()
        WHERE id = $1 AND payment_status IN ('unpaid', 'authorized')`,
      [intent.metadata.ride_id],
    );
    // Referral: prima cursă plătită validează atribuirea pasagerului — doar o
    // cursă finalizată (o taxă de anulare capturată nu e o cursă plătită).
    const { rows: rideRows } = await dbQuery<{ status: string }>(
      `SELECT status FROM rides WHERE id = $1`,
      [intent.metadata.ride_id],
    );
    if (rideRows[0]?.status === "completed") await onRidePaid(intent.metadata.ride_id, intent.id);
    // Dacă șoferul a finalizat cursa înainte ca captura să ajungă, decontarea a
    // fost refuzată (payment_status nu era încă 'captured') și `settled_at` a
    // rămas NULL. Acum banii au intrat — reluăm. Idempotent pe (ref_type, ref_id);
    // pentru o cursă care nu e 'completed', settleRide iese cu null.
    try {
      await settleRide(intent.metadata.ride_id);
    } catch (err) {
      logger.error({ err, rideId: intent.metadata.ride_id }, "[webhook] decontarea cursei după capture a eșuat");
    }
  } else if (intent.metadata?.kind === "stay_booking" && intent.metadata?.stay_booking_id) {
    // Stays: rezervare plătită cu cardul → confirmare + credit gazdă.
    await markStayBookingPaidByCard(intent.metadata.stay_booking_id);
  } else if (intent.metadata?.kind === "mission_funding") {
    // Misiuni: fondul de premii plătit de seller → misiunea devine activă
    // (idempotent: doar rândurile încă nefinanțate trec în funded).
    await markMissionFunded({
      paymentIntentId: intent.id,
      missionId: intent.metadata.mission_id ?? null,
      amountReceivedCents: intent.amount_received ?? intent.amount,
      currency: intent.currency,
    });
  } else if (intent.metadata?.kind === "donation" && intent.metadata?.donation_id) {
    // Swypik Cares: donație plătită → paid + agregate campanie (idempotent
    // prin guard-ul payment_status='pending').
    await markDonationPaid(intent.metadata.donation_id);
  } else {
    await handlePaymentIntentSucceeded(intent);
  }
}

async function markDonationPaid(donationId: string): Promise<void> {
  const { rows } = await dbQuery<{ campaign_id: string; amount_cents: number }>(
    `UPDATE donations
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1::uuid AND payment_status = 'pending'
      RETURNING campaign_id, amount_cents`,
    [donationId],
  );
  const d = rows[0];
  if (!d) return; // deja procesată (retry webhook) sau inexistentă
  await dbQuery(
    `UPDATE donation_campaigns
        SET raised_cents = raised_cents + $2,
            donors_count = donors_count + 1,
            updated_at = now()
      WHERE id = $1::uuid`,
    [d.campaign_id, d.amount_cents],
  );
  logger.info({ donationId, campaignId: d.campaign_id, amountCents: d.amount_cents }, "[donations] paid via webhook");
}

export async function handlePaymentIntentFailed(event: Stripe.Event) {
  const intent = event.data.object as Stripe.PaymentIntent;
  if (intent.metadata?.kind === "local_order" && intent.metadata?.local_order_id) {
    await markLocalOrderPaymentFailed(intent.metadata.local_order_id);
  }
  if (intent.metadata?.kind === "ride" && intent.metadata?.ride_id) {
    await dbQuery(
      `UPDATE rides SET payment_status = 'failed', updated_at = now()
        WHERE id = $1 AND payment_status IN ('unpaid', 'authorized')`,
      [intent.metadata.ride_id],
    );
  }
  if (intent.metadata?.kind === "stay_booking" && intent.metadata?.stay_booking_id) {
    await markStayBookingCardFailed(intent.metadata.stay_booking_id);
  }
  if (
    intent.metadata?.kind === "donation" &&
    intent.metadata?.donation_id &&
    intent.status === "canceled"
  ) {
    // Doar la anulare DEFINITIVĂ — un card declinat mai poate fi reîncercat.
    await dbQuery(
      `UPDATE donations SET payment_status = 'failed'
        WHERE id = $1::uuid AND payment_status = 'pending'`,
      [intent.metadata.donation_id],
    );
  }
  logger.warn(`[Stripe Webhook] Payment failed: ${intent.id} - ${intent.last_payment_error?.message}`);
  await logCheckoutEvent("checkout_fail", {
    error: intent.last_payment_error?.message || "payment_intent.payment_failed",
    payload: { stage: "payment_failed", paymentIntentId: intent.id },
  });
}

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const orderId = intent.metadata?.orderId;
  if (!orderId) {
    logger.info({ intent_id: intent.id }, "[Stripe Webhook] payment intent succeeded without orderId metadata");
    return;
  }

  logger.info({ order_id: orderId, intent_id: intent.id }, "[Stripe Webhook] payment intent succeeded");

  const { rows: orderRows } = await dbQuery(
    `SELECT id, status, currency, total_cents FROM commerce_orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  if (orderRows.length === 0) throw new Error(`Order ${orderId} not found for payment intent ${intent.id}`);
  const order = orderRows[0];
  if (order.status !== "pending") {
    logger.info({ order_id: orderId, current_status: order.status }, "[Stripe Webhook] order already past pending; skipping paid transition");
    await maybeSendOrderConfirmation(orderId);
    return;
  }
  if (Number(order.total_cents) !== Number(intent.amount) || String(order.currency).toUpperCase() !== String(intent.currency).toUpperCase()) {
    throw new Error(`Payment intent ${intent.id} amount/currency mismatch for order ${orderId}`);
  }

  const shipping = intent.shipping;
  let shippingAddress: Record<string, string | null | undefined> | null = null;
  if (shipping) {
    shippingAddress = {
      name: shipping.name,
      phone: shipping.phone,
      line1: shipping.address?.line1,
      line2: shipping.address?.line2,
      city: shipping.address?.city,
      state: shipping.address?.state,
      postal_code: shipping.address?.postal_code,
      country: shipping.address?.country,
    };
  }

  // `intent.charges` nu mai există în versiunile curente ale API-ului Stripe.
  // Emailul clientului e salvat deja pe comandă la checkout; îl suprascriem
  // doar cu o valoare reală (un `null` în merge-ul jsonb l-ar șterge).
  const metadata: Record<string, unknown> = {
    stripe_payment_intent: intent.id,
    fulfillment_status: "pending",
    shipping_address: shippingAddress,
    ...(intent.receipt_email ? { customer_email: intent.receipt_email } : {}),
  };

  // Update the pending order to paid (idempotent via RETURNING gate).
  const { rows: transitionRows } = await dbQuery<{ id: string; buyer_user_id: string | null }>(
    `UPDATE commerce_orders 
     SET status = 'paid', 
         placed_at = COALESCE(placed_at, now()),
         metadata = metadata || $1::jsonb
     WHERE id = $2 AND status = 'pending'
     RETURNING id, buyer_user_id::text AS buyer_user_id`,
    [JSON.stringify(metadata), orderId]
  );

  // Decrement stock atomically ONLY on the actual pending->paid transition.
  // The processed_stripe_events guard at the top of POST() neutralizes Stripe
  // event retries; this RETURNING gate additionally protects against any
  // non-webhook path that may have already flipped the order out of 'pending'.
  if (transitionRows.length > 0) {
    await decrementOrderStock(orderId);
    await evaluateFraudRisk(orderId).catch((e) =>
      logger.error({ err: e, orderId }, "[fraud-risk] evaluation failed"),
    );
    await attributeOrder(orderId).catch((e) =>
      logger.error({ err: e, orderId }, "[algo] video attribution failed"),
    );
    // Referral: validat la prima comandă plătită (best-effort, nu blochează).
    await onOrderPaid(orderId, intent.id);
    // Magazin: eliberează rezervarea, închide coșul, notifică cumpărătorul.
    await finalizePaidShopOrder(orderId);
    // Arcade: prima comandă plătită → XP „first_purchase” (idempotent, nu aruncă).
    await awardMilestoneXp(transitionRows[0].buyer_user_id, "first_purchase");
  }

  // Record payment transaction
  await dbQuery(
    `INSERT INTO payment_transactions (
      order_id, provider, provider_payment_id, transaction_type,
      status, currency, amount_cents, processed_at, metadata
    ) VALUES ($1, 'stripe', $2, 'payment', 'succeeded', $3, $4, now(), $5::jsonb)
    ON CONFLICT (provider, provider_payment_id, transaction_type)
    DO UPDATE SET status = 'succeeded', processed_at = now()`,
    [
      orderId,
      intent.id,
      String(intent.currency || "ron").toUpperCase(),
      intent.amount,
      JSON.stringify(metadata),
    ]
  );

  await maybeSendOrderConfirmation(orderId);

  if (transitionRows.length > 0) {
    try {
      const { rows: itemRows } = await dbQuery<{
        product_id: string | null;
        title: string;
        quantity: number;
        unit_amount_cents: number;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT product_id::text AS product_id, title, quantity, unit_amount_cents, metadata
           FROM commerce_order_items WHERE order_id = $1`,
        [orderId]
      );
      const items = itemRows.map((r) => ({
        // `metadata` e `Record<string, unknown>`, deci câmpurile ei ies ca
        // `unknown`. Convertim explicit la string: `as any` ascundea doar
        // faptul că un `pg_id` numeric ar fi ajuns netransformat.
        productId: r.product_id || String(r.metadata?.pg_id ?? r.metadata?.product_id ?? ""),
        skuId: (r.metadata?.sku_id ?? r.metadata?.skuId) as string | undefined,
        title: r.title,
        quantity: Number(r.quantity) || 1,
        price: Number(r.unit_amount_cents || 0) / 100,
        metadata: r.metadata || {},
      }));
      await routeOrder(orderId, items);
    } catch (err) {
      logger.error({ err, orderId }, "[Stripe Webhook] routeOrder failed after payment_intent.succeeded");
    }
  }
}

/**
 * Evaluează scorul de fraudă imediat după transition pending→paid.
 * Dacă score ≥50: marchează metadata.fraud_review + ops alert.
 * Dacă score ≥70 (critical): adaugă fraud_block=true (fulfillment cron-ul îl va skip).
 */
async function evaluateFraudRisk(orderId: string): Promise<void> {
  const { rows } = await dbQuery<{
    id: string;
    status: string;
    buyer_user_id: string | null;
    currency: string;
    total_cents: number;
    metadata: Record<string, unknown> | null;
    buyer_email: string | null;
    buyer_phone: string | null;
    buyer_email_verified_at: string | null;
    buyer_phone_verified_at: string | null;
    buyer_created_at: string | null;
    prior_paid: number;
    prior_disputes: number;
    prior_chargebacks_lost: number;
  }>(
    `SELECT co.id::text, co.status, co.buyer_user_id::text,
            co.currency, co.total_cents, co.metadata,
            u.email AS buyer_email,
            u.phone AS buyer_phone,
            u.email_verified_at::text AS buyer_email_verified_at,
            u.phone_verified_at::text AS buyer_phone_verified_at,
            u.created_at::text AS buyer_created_at,
            (SELECT COUNT(*)::int FROM commerce_orders co2
              WHERE co2.buyer_user_id = co.buyer_user_id
                AND co2.status IN ('paid','fulfilled','delivered')
                AND co2.id <> co.id) AS prior_paid,
            (SELECT COUNT(*)::int FROM stripe_disputes d
              JOIN commerce_orders co3 ON co3.id = d.order_id
              WHERE co3.buyer_user_id = co.buyer_user_id) AS prior_disputes,
            (SELECT COUNT(*)::int FROM stripe_disputes d
              JOIN commerce_orders co3 ON co3.id = d.order_id
              WHERE co3.buyer_user_id = co.buyer_user_id
                AND d.status IN ('lost','dispute_lost')) AS prior_chargebacks_lost
       FROM commerce_orders co
       LEFT JOIN users u ON u.id = co.buyer_user_id
      WHERE co.id = $1 LIMIT 1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) return;

  interface RiskAddress {
    line1?: string | null;
    address_line_1?: string | null;
    country?: string | null;
  }
  const md = (o.metadata || {}) as {
    shipping_address?: RiskAddress;
    billing_address?: RiskAddress;
    items?: unknown[];
    item_count?: number | string;
    checkout_ip_country?: string | null;
    [key: string]: unknown;
  };
  const ship = md.shipping_address || {};
  const bill = md.billing_address || {};
  const items = Array.isArray(md.items) ? md.items : [];
  const itemCount = Number(md.item_count) || items.length || 1;
  const accountAgeDays = o.buyer_created_at
    ? Math.floor((Date.now() - new Date(o.buyer_created_at).getTime()) / 86_400_000)
    : null;

  const risk = scoreOrderRisk({
    totalCents: o.total_cents,
    currency: o.currency,
    itemCount,
    hasShippingAddress: Boolean(ship.line1 || ship.address_line_1),
    shippingCountry: ship.country || null,
    billingCountry: bill.country || null,
    ipCountry: md.checkout_ip_country || null,
    email: o.buyer_email,
    phone: o.buyer_phone,
    buyerAccountAgeDays: o.buyer_user_id ? accountAgeDays : null,
    emailVerified: Boolean(o.buyer_email_verified_at),
    phoneVerified: Boolean(o.buyer_phone_verified_at),
    priorPaidOrders: o.prior_paid,
    priorDisputes: o.prior_disputes,
    priorChargebacksLost: o.prior_chargebacks_lost,
  });

  // Always persist score for audit + later calibration vs real outcome.
  const patch: Record<string, unknown> = {
    fraud_score: risk.score,
    fraud_level: risk.level,
    fraud_evaluated_at: new Date().toISOString(),
    fraud_factors: risk.factors.map((f) => f.tag),
  };
  if (risk.score >= FRAUD_REVIEW_SCORE) patch.fraud_review = true;
  if (risk.score >= FRAUD_BLOCK_SCORE) patch.fraud_block = true;

  await dbQuery(
    `UPDATE commerce_orders SET metadata = metadata || $1::jsonb WHERE id = $2`,
    [JSON.stringify(patch), orderId],
  );

  if (risk.score >= FRAUD_REVIEW_SCORE) {
    const severity = risk.score >= FRAUD_BLOCK_SCORE ? "critical" : "warning";
    const positives = risk.factors.filter((f) => f.delta > 0);
    await notifyOps({
      key: `fraud_block:${orderId}`,
      severity,
      title: `Fraud risk ${risk.score}/100 — ${risk.level.toUpperCase()} — ${(o.total_cents / 100).toFixed(2)} ${o.currency.toUpperCase()}`,
      detail:
        `${o.buyer_email || "(guest)"} · ship=${ship.country || "?"} · items=${itemCount}\n` +
        risk.recommendation +
        "\n\nSemnale: " +
        positives.map((f) => `${f.tag}+${f.delta}`).join(", "),
      link: `${APP_URL}/admin/risk?status=paid&min=${FRAUD_REVIEW_SCORE}`,
      payload: { orderId, score: risk.score, level: risk.level, factors: risk.factors },
      cooldownMin: 5, // o singură comandă, e ok să alertăm rapid
    });
  }

  // User-level auto-block check (only for authenticated buyers, only on review+ scores)
  if (o.buyer_user_id && risk.score >= FRAUD_REVIEW_SCORE) {
    try {
      const { maybeAutoBlockUser } = await import("@/lib/risk/user-block");
      await maybeAutoBlockUser({
        userId: o.buyer_user_id,
        triggeringOrderId: orderId,
        currentScore: risk.score,
      });
    } catch (e) {
      logger.error({ err: e, userId: o.buyer_user_id }, "[fraud-user-block] check failed");
    }
  }
}

async function decrementOrderStock(orderId: string) {
  // Pull order items recorded by /api/checkout (embedded flow). We decrement
  // per (product_id, variant_id) atomically using a CHECK-guarded UPDATE so
  // the row only changes when sufficient stock exists. Variants use a real
  // integer column; product-level fallback uses metadata.available_stock
  // (jsonb int) since marketplace_products has no top-level stock column.
  let items: Array<{ product_id: string | null; variant_id: string | null; quantity: number; title: string | null }> = [];
  try {
    const { rows } = await dbQuery<{ product_id: string | null; variant_id: string | null; quantity: number; title: string | null }>(
      `SELECT product_id::text AS product_id, variant_id::text AS variant_id, quantity, title
         FROM commerce_order_items WHERE order_id = $1`,
      [orderId]
    );
    items = rows;
  } catch (e) {
    logger.error({ err: e, orderId }, '[Stripe Webhook] Failed to load order items for stock decrement');
    return;
  }

  for (const it of items) {
    const qty = Number(it.quantity) || 0;
    if (qty <= 0) continue;
    try {
      if (it.variant_id) {
        const { rowCount } = await dbQuery(
          `UPDATE marketplace_product_variants
              SET inventory_quantity = inventory_quantity - $1,
                  updated_at = now()
            WHERE id = $2 AND inventory_quantity IS NOT NULL AND inventory_quantity >= $1`,
          [qty, it.variant_id]
        );
        if (!rowCount) {
          logger.warn({ orderId, variantId: it.variant_id, qty, title: it.title }, '[Stripe Webhook] Oversell prevented: variant stock insufficient or NULL; manual review required');
        }
      } else if (it.product_id) {
        const { rowCount } = await dbQuery(
          `UPDATE marketplace_products
              SET metadata = jsonb_set(metadata, '{available_stock}', to_jsonb(GREATEST(0, COALESCE((metadata->>'available_stock')::int, 0) - $1)), true),
                  updated_at = now()
            WHERE id = $2 AND COALESCE((metadata->>'available_stock')::int, 0) >= $1`,
          [qty, it.product_id]
        );
        if (!rowCount) {
          logger.warn({ orderId, productId: it.product_id, qty, title: it.title }, '[Stripe Webhook] Oversell prevented: product available_stock insufficient or missing; manual review required');
        }
      }
    } catch (e) {
      logger.error({ err: e, orderId, productId: it.product_id, variantId: it.variant_id }, '[Stripe Webhook] Stock decrement failed');
    }
  }
}
