import type Stripe from "stripe";
import crypto from "crypto";
import { getStripe } from "@/lib/stripe/checkout";
import { withTransaction, type TxQuery } from "@/lib/db";
import { routeOrder } from "@/lib/fulfillment/order-router";
import { logger } from "@/lib/logger";
import { onOrderPaid } from "@/lib/referral/validation";
import { maybeSendOrderConfirmation } from "./shared";

export async function handleCheckoutCompletedEvent(event: Stripe.Event) {
  await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Completing Checkout does not mean a delayed payment has settled.
  // async_payment_succeeded re-enters this handler once Stripe confirms funds.
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    logger.info({ session_id: session.id, payment_status: session.payment_status }, "[Stripe Webhook] checkout awaiting payment");
    return;
  }

  logger.info({ session_id: session.id }, "[Stripe Webhook] checkout completed");

  // Swypik Fly: bilet de avion — fulfill separat, nu intră în commerce_orders.
  const flyBookingId = session.metadata?.fly_booking_id;
  if (flyBookingId) {
    const { fulfillFlightBooking } = await import("@/lib/fly/booking");
    await fulfillFlightBooking(flyBookingId);
    return;
  }

  const stripe = getStripe();
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 20,
    expand: ["data.price.product"],
  });
  const items = lineItems.data.map((li) => ({
    id: li.id,
    name: li.description || "Product",
    price: (li.amount_total || 0) / 100,
    unitAmountCents: li.price?.unit_amount || Math.round(((li.amount_total || 0) / Math.max(li.quantity || 1, 1))),
    amountTotalCents: li.amount_total || 0,
    quantity: li.quantity || 1,
    currency: li.currency,
    // `price.product` e `string | Product | DeletedProduct`. Doar `Product` are
    // `metadata`; îngustăm la ce citim în loc să dezactivăm verificarea.
    metadata:
      typeof li.price?.product === "object" && li.price.product
        ? ((li.price.product as { metadata?: Record<string, string> }).metadata ?? {})
        : {},
  }));

  const totalCents = session.amount_total || 0;
  const totalRon = totalCents / 100;
  const taxCents = session.total_details?.amount_tax ?? 0;
  const taxCountry = session.customer_details?.address?.country || null;
  // `tax_ids` apare pe `customer_details` doar când sesiunea a fost creată cu
  // `tax_id_collection` activ, deci nu e în tipul de bază.
  const taxIds = (session.customer_details as { tax_ids?: Array<{ type: string; value: string | null }> } | null)
    ?.tax_ids;
  const taxIdCollected = Array.isArray(taxIds) && taxIds.length > 0
    ? `${taxIds[0].type}:${taxIds[0].value}`
    : null;
  // `shipping_details` a înlocuit `shipping` în API-ul Stripe; citim ambele ca
  // să acoperim sesiuni vechi. Niciunul nu e în tipul curent al SDK-ului.
  type StripeShipping = {
    name?: string | null;
    address?: {
      line1?: string | null; line2?: string | null; city?: string | null;
      state?: string | null; postal_code?: string | null; country?: string | null;
    } | null;
  };
  const sessionShipping = session as unknown as {
    shipping_details?: StripeShipping | null;
    shipping?: StripeShipping | null;
  };
  const shipping = sessionShipping.shipping_details || sessionShipping.shipping;
  const shippingAddress = shipping ? {
    name: shipping.name,
    line1: shipping.address?.line1,
    line2: shipping.address?.line2,
    city: shipping.address?.city,
    state: shipping.address?.state,
    postal_code: shipping.address?.postal_code,
    country: shipping.address?.country,
  } : null;

  const baseMetadata = {
    stripe_session_id: session.id,
    stripe_payment_intent: session.payment_intent || null,
    customer_email: session.customer_details?.email || session.customer_email || null,
    customer_phone: session.customer_details?.phone || null,
    fulfillment_status: "pending",
    items,
    shipping_address: shippingAddress,
  };

  // P0-01: comanda, liniile, sesiunea de checkout și tranzacția de plată se
  // persistă ATOMIC. Altfel un crash între INSERT-uri lăsa o comandă `paid`
  // fără items, iar retry-ul Stripe crea un duplicat (checkout_sessions nu
  // apucase să fie scris). `FOR UPDATE` pe lookup serializează retry-urile
  // concurente ale aceluiași eveniment.
  const orderId = await withTransaction(async (q) => {
    const { rows: existing } = await q<{ id: string }>(
      `SELECT cs.order_id AS id
         FROM checkout_sessions cs
        WHERE cs.provider = 'stripe' AND cs.provider_session_id = $1
        LIMIT 1
        FOR UPDATE`,
      [session.id]
    );

    let currentOrderId: string | undefined = existing[0]?.id;
    const metadata = existing.length > 0
      ? baseMetadata
      : { ...baseMetadata, order_lookup_token: crypto.randomBytes(24).toString("hex") };
    if (existing.length > 0) {
      await q(
        `UPDATE commerce_orders
       SET status = 'paid',
           currency = upper($2),
           subtotal_cents = $3,
           total_cents = $3,
           tax_cents = $5,
           tax_country = $6,
           tax_id_collected = $7,
           placed_at = COALESCE(placed_at, now()),
           metadata = metadata || $4::jsonb
       WHERE id = $1`,
        [currentOrderId, session.currency || "ron", totalCents, JSON.stringify(metadata), taxCents, taxCountry, taxIdCollected]
      );
    } else {
      const { rows: orderRows } = await q<{ id: string }>(
        `INSERT INTO commerce_orders (
        status, currency, subtotal_cents, total_cents, tax_cents, tax_country, tax_id_collected, placed_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb)
      RETURNING id`,
        ["paid", String(session.currency || "ron").toUpperCase(), totalCents, totalCents, taxCents, taxCountry, taxIdCollected, JSON.stringify(metadata)]
      );
      currentOrderId = orderRows[0]?.id;
    }
    if (!currentOrderId) throw new Error(`Could not persist order for Stripe session ${session.id}`);

    await persistOrderItems(q, currentOrderId, items);

    const { rows: sessionRows } = await q<{ id: string }>(
      `INSERT INTO checkout_sessions (
      order_id, provider, provider_session_id, status, currency, amount_total_cents,
      completed_at, metadata
    ) VALUES ($1, 'stripe', $2, 'completed', $3, $4, now(), $5::jsonb)
    ON CONFLICT (provider, provider_session_id)
    DO UPDATE SET status = 'completed', completed_at = now(), order_id = EXCLUDED.order_id
    RETURNING id`,
      [currentOrderId, session.id, String(session.currency || "ron").toUpperCase(), totalCents, JSON.stringify(metadata)]
    );

    await q(
      `INSERT INTO payment_transactions (
      order_id, checkout_session_id, provider, provider_payment_id, transaction_type,
      status, currency, amount_cents, processed_at, metadata
    ) VALUES ($1, $2, 'stripe', $3, 'payment', 'succeeded', $4, $5, now(), $6::jsonb)
    ON CONFLICT (provider, provider_payment_id, transaction_type)
    DO UPDATE SET status = 'succeeded', processed_at = now(), order_id = EXCLUDED.order_id`,
      [
        currentOrderId,
        sessionRows[0]?.id,
        String(session.payment_intent || `checkout_${session.id}`),
        String(session.currency || "ron").toUpperCase(),
        totalCents,
        JSON.stringify(metadata),
      ]
    );

    return currentOrderId;
  });

  // Side-effects (email, webhooks, fulfillment) rulează DUPĂ commit: nu
  // trebuie să țină tranzacția deschisă și nu se pot da rollback.
  await maybeSendOrderConfirmation(orderId);

  // Referral: validat la prima comandă plătită (atomic, best-effort).
  await onOrderPaid(orderId, String(session.payment_intent || `checkout_${session.id}`));

  logger.info({ order_id: orderId, session_id: session.id, total_ron: totalRon, items_count: items.length }, "[Stripe Webhook] order saved");

  // --- Fulfillment Orchestration ---
  try {
    // NEPOTRIVIRE DE FORMĂ, mascată până acum de `as any`:
    // `items` construit mai sus are {id, name, price, ...}, dar `OrderItem`
    // (lib/fulfillment/order-router.ts) cere {productId, title, quantity, price}.
    // Deci `routeOrder` primea obiecte fără `productId` — cheia după care își
    // grupează itemele. Convertim explicit, ca nepotrivirea să fie vizibilă.
    const routableItems = items.map((i) => ({
      productId: String(i.metadata?.product_id ?? i.metadata?.pg_id ?? i.id),
      title: i.name,
      quantity: i.quantity,
      price: i.price,
      metadata: i.metadata,
    }));
    const fulfillmentPlan = await routeOrder(orderId, routableItems);
    // Logul citea `fulfillmentPlan.groups`, câmp care NU EXISTĂ pe
    // `FulfillmentPlan` ({manual, localSellers}) — deci raporta mereu 0.
    // `as any` a ascuns și asta. Acum logăm ce chiar există.
    logger.info(
      {
        order_id: orderId,
        plan_summary: {
          manual: fulfillmentPlan.manual.length,
          selleri: Object.keys(fulfillmentPlan.localSellers).length,
        },
      },
      "[Stripe Webhook] fulfillment plan generated",
    );
  } catch (err) {
    logger.error({ err: err }, `[Stripe Webhook] Fulfillment routing failed for Order ${orderId}:`);
  }
}

async function persistOrderItems(q: TxQuery, orderId: string, items: Array<{
  id: string;
  name: string;
  unitAmountCents: number;
  amountTotalCents: number;
  quantity: number;
  currency: string;
  metadata: Record<string, string>;
}>) {
  for (const item of items) {
    const pgId = item.metadata.pgId || item.metadata.pg_id || item.metadata.productId || item.metadata.product_id || null;
    const skuId = item.metadata.skuId || item.metadata.sku_id || null;
    const externalLineItemId = pgId ? `${pgId}:${skuId || "default"}` : item.id;
    let variantId: string | null = null;
    if (pgId && skuId) {
      const { rows } = await q<{ id: string }>(
        `SELECT id::text AS id FROM marketplace_product_variants WHERE product_id = $1 AND sku = $2 LIMIT 1`,
        [pgId, skuId],
      );
      variantId = rows[0]?.id || null;
    }

    await q(
      `INSERT INTO commerce_order_items (
        order_id, product_id, variant_id, external_line_item_id, title, quantity, currency,
        unit_amount_cents, gross_amount_cents, commissionable_amount_cents, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10::jsonb, now())
      ON CONFLICT (order_id, external_line_item_id)
      WHERE external_line_item_id IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        quantity = EXCLUDED.quantity,
        unit_amount_cents = EXCLUDED.unit_amount_cents,
        gross_amount_cents = EXCLUDED.gross_amount_cents,
        commissionable_amount_cents = EXCLUDED.commissionable_amount_cents,
        metadata = commerce_order_items.metadata || EXCLUDED.metadata`,
      [
        orderId,
        pgId,
        variantId,
        externalLineItemId,
        item.name,
        item.quantity,
        (item.currency || "ron").toUpperCase(),
        item.unitAmountCents,
        item.amountTotalCents,
        JSON.stringify({
          source: "stripe_webhook",
          pg_id: pgId,
          sku_id: skuId,
          seller_id: item.metadata.sellerId || item.metadata.seller_id || null,
          creator_id: item.metadata.creatorId || item.metadata.creator_id || null,
          video_id: item.metadata.videoId || item.metadata.video_id || null,
          creator_product_link_id: item.metadata.creatorProductLinkId || item.metadata.creator_product_link_id || null,
          stripe_line_item_id: item.id,
          stripe_product_metadata: item.metadata,
        }),
      ]
    );

    // Deduct stock. Single-statement UPDATE is atomic per row in Postgres, so
    // concurrent webhooks serialize on the row lock — no double-decrement.
    // We track the REAL post-sale quantity (can go conceptually negative) via
    // RETURNING: if the clamped value hit 0 while quantity sold exceeded what
    // was left, that's an OVERSELL — payment already succeeded, so we log it
    // loudly for ops follow-up (refund/backorder) instead of hiding it.
    //
    // P0-01: rulăm acum într-o tranzacție deschisă de apelant. Decrementarea
    // e best-effort (o eroare aici NU trebuie să anuleze comanda plătită), dar
    // în Postgres orice eroare abortează tranzacția — deci izolăm fiecare
    // încercare într-un SAVEPOINT pe care îl derulăm înapoi la eșec.
    if (skuId && pgId) {
      try {
        await q("SAVEPOINT stock_deduct");
        const { rows: stockRows } = await q<{ inventory_quantity: number }>(
          `UPDATE marketplace_product_variants
             SET inventory_quantity = GREATEST(0, inventory_quantity - $1)
           WHERE product_id = $2 AND sku = $3
           RETURNING inventory_quantity`,
          [item.quantity, String(pgId), String(skuId)]
        );
        await q("RELEASE SAVEPOINT stock_deduct");
        if (stockRows[0] && stockRows[0].inventory_quantity === 0) {
          logger.warn({ productId: pgId, sku: skuId, qtySold: item.quantity }, "[Stripe Webhook] OVERSELL RISK: variant stock hit 0 after sale — verify no oversell");
        }
      } catch (e) {
        await q("ROLLBACK TO SAVEPOINT stock_deduct").catch(() => undefined);
        logger.error({ err: e }, `[Stripe Webhook] Error deducting variant stock for product ${pgId} SKU ${skuId}`);
      }
    } else if (skuId) {
      // No product_id available - fall back to SKU-only update but log a
      // warning since this is ambiguous if SKUs collide across products.
      logger.warn(`[Stripe Webhook] Decrementing variant stock without product_id scope (SKU ${skuId}); SKU collisions across products may decrement the wrong row.`);
      try {
        await q("SAVEPOINT stock_deduct");
        await q(
          `UPDATE marketplace_product_variants SET inventory_quantity = GREATEST(0, inventory_quantity - $1) WHERE sku = $2`,
          [item.quantity, String(skuId)]
        );
        await q("RELEASE SAVEPOINT stock_deduct");
      } catch (e) {
        await q("ROLLBACK TO SAVEPOINT stock_deduct").catch(() => undefined);
        logger.error({ err: e }, `[Stripe Webhook] Error deducting variant stock for SKU ${skuId}`);
      }
    } else if (pgId) {
      // Stocul la nivel de produs e `metadata.available_stock` (ca la checkout-ul
      // nou și la POS); `marketplace_products.inventory_quantity` NU există — vechiul
      // UPDATE eșua mereu, iar eroarea era înghițită. Stoc negestionat → nimic de scăzut.
      try {
        await q("SAVEPOINT stock_deduct");
        const { rows: stockRows } = await q<{ stock: string | null }>(
          `UPDATE marketplace_products
              SET metadata = jsonb_set(metadata, '{available_stock}',
                    to_jsonb(GREATEST(0, (metadata->>'available_stock')::numeric - $1))),
                  updated_at = now()
            WHERE id = $2 AND NULLIF(metadata->>'available_stock', '') IS NOT NULL
            RETURNING metadata->>'available_stock' AS stock`,
          [item.quantity, String(pgId)]
        );
        await q("RELEASE SAVEPOINT stock_deduct");
        if (stockRows[0] && Number(stockRows[0].stock) === 0) {
          logger.warn({ productId: pgId, qtySold: item.quantity }, "[Stripe Webhook] OVERSELL RISK: product stock hit 0 after sale — verify no oversell");
        }
      } catch (e) {
        await q("ROLLBACK TO SAVEPOINT stock_deduct").catch(() => undefined);
        logger.error({ err: e }, `[Stripe Webhook] Error deducting product stock for ID ${pgId}`);
      }
    }
  }
}
