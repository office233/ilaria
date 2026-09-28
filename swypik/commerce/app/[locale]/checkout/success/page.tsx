import { dbQuery } from "@/lib/db";
import { SuccessView, type SuccessOrder } from "@/components/shop/checkout/SuccessView";
import { logger } from "@/lib/logger";
import { getStripe } from "@/lib/stripe/checkout";
import { getOptionalSocialUserId } from "@/lib/social/session";
import crypto from "crypto";
import { getTranslations } from "next-intl/server";

function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

type SearchParams = { session_id?: string; payment_intent?: string; order_token?: string; redirect_status?: string };

/** Statusuri de după plată: comanda a fost încasată (inclusiv expediată/livrată). */
const PAID_STATUSES = new Set(["paid", "fulfilled", "partially_fulfilled", "shipped", "delivered", "completed"]);

export default async function CheckoutSuccess({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const t = await getTranslations("success");
  const sp = await searchParams;
  let order: any = null;
  let lookupError = false;
  let paymentConfirmed = false;

  const sessionId = sp.session_id;
  const paymentIntentId = sp.payment_intent;
  const providedToken = typeof sp.order_token === "string" ? sp.order_token : null;
  const authedUserId = await getOptionalSocialUserId().catch(() => null);

  if (sessionId) {
    try {
      const { rows } = await dbQuery(
        `SELECT
           ord.id,
           ord.buyer_user_id,
           cs.provider_session_id AS stripe_session_id,
           ord.metadata->>'customer_email' AS customer_email,
           (ord.total_cents::numeric / 100) AS total_ron,
           ord.metadata->'items' AS items,
           ord.metadata->'shipping_address' AS shipping_address,
           ord.metadata->>'order_lookup_token' AS order_lookup_token,
           ord.status,
           ord.currency,
           ord.created_at
         FROM commerce_orders ord
         JOIN checkout_sessions cs ON ord.id = cs.order_id
         WHERE cs.provider_session_id = $1
         LIMIT 1`,
        [sessionId]
      );

      if (rows.length > 0) {
        order = rows[0];

        if (order.status === "pending") {
          const stripe = getStripe();
          const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ["payment_intent"],
          });

          if (session.payment_status === "paid") {
            const customerDetails = session.customer_details;
            const shippingAddress = customerDetails?.address
              ? {
                  name: customerDetails.name,
                  phone: customerDetails.phone,
                  line1: customerDetails.address.line1,
                  line2: customerDetails.address.line2,
                  city: customerDetails.address.city,
                  state: customerDetails.address.state,
                  postal_code: customerDetails.address.postal_code,
                  country: customerDetails.address.country,
                }
              : null;

            paymentConfirmed = true;
            order.customer_email = customerDetails?.email || order.customer_email;
            order.shipping_address = shippingAddress || order.shipping_address;
          }
        }
      }
    } catch (error) {
      lookupError = true;
      logger.error({ err: error }, "[CheckoutSuccess] Error fetching order");
    }
  } else if (paymentIntentId) {
    try {
      const { rows } = await dbQuery(
        `SELECT
           ord.id,
           ord.buyer_user_id,
           ord.metadata->>'stripe_payment_intent' AS stripe_payment_intent,
           ord.metadata->>'customer_email' AS customer_email,
           (ord.total_cents::numeric / 100) AS total_ron,
           ord.metadata->'items' AS items,
           ord.metadata->'shipping_address' AS shipping_address,
           ord.metadata->>'order_lookup_token' AS order_lookup_token,
           ord.status,
           ord.currency,
           ord.created_at
         FROM commerce_orders ord
         WHERE ord.metadata->>'stripe_payment_intent' = $1
         LIMIT 1`,
        [paymentIntentId]
      );

      if (rows.length > 0) {
        order = rows[0];

        if (order.status === "pending") {
          const stripe = getStripe();
          const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
          if (intent.status === "succeeded") {
            const shipping = intent.shipping;
            const shippingAddress = shipping
              ? {
                  name: shipping.name,
                  phone: shipping.phone,
                  line1: shipping.address?.line1,
                  line2: shipping.address?.line2,
                  city: shipping.address?.city,
                  state: shipping.address?.state,
                  postal_code: shipping.address?.postal_code,
                  country: shipping.address?.country,
                }
              : null;

            paymentConfirmed = true;
            order.customer_email = intent.receipt_email || order.customer_email;
            order.shipping_address = shippingAddress || order.shipping_address;
          }
        }
      }
    } catch (error) {
      lookupError = true;
      logger.error({ err: error }, "[CheckoutSuccess] Error fetching payment intent order");
    }
  }

  // ── PII gate: only reveal order details if requester proves access ──
  // Allow:
  //  - Stripe session_id branch (the id itself is a one-shot capability scoped to this checkout).
  //  - payment_intent branch only if (a) auth session match buyer_user_id, OR
  //    (b) ?order_token= matches metadata.order_lookup_token via timingSafeEqual.
  let pii_ok = false;
  if (order) {
    if (sessionId) {
      pii_ok = true;
    } else if (paymentIntentId) {
      if (authedUserId && order.buyer_user_id && String(order.buyer_user_id) === String(authedUserId)) {
        pii_ok = true;
      } else if (providedToken && tokensMatch(providedToken, order.order_lookup_token)) {
        pii_ok = true;
      }
    }
  }
  if (order && !pii_ok) {
    // Don't leak PII (email/shipping/items/total). Keep only generic flags so we can render "success".
    order = {
      id: order.id,
      status: order.status,
      created_at: order.created_at,
      customer_email: null,
      shipping_address: null,
      items: null,
      total_ron: null,
      order_lookup_token: null,
      buyer_user_id: null,
    };
  }

  let items = pii_ok && order?.items ? (typeof order.items === "string" ? JSON.parse(order.items) : order.items) : [];
  if (pii_ok && order && items.length === 0) {
    const { rows } = await dbQuery(
      `SELECT title, quantity, (unit_amount_cents::numeric / 100) AS price
       FROM commerce_order_items WHERE order_id = $1 ORDER BY created_at`,
      [order.id]
    );
    items = rows;
  }

  const shipping =
    pii_ok && order?.shipping_address && typeof order.shipping_address === "string"
      ? JSON.parse(order.shipping_address)
      : (pii_ok ? order?.shipping_address : null) || null;

  const hasLookup = Boolean(sessionId || paymentIntentId);
  const isPaid = PAID_STATUSES.has(String(order?.status ?? "")) || paymentConfirmed;
  // Stripe întoarce redirect_status=failed când banca/wallet-ul a respins plata.
  const isFailed = !isPaid && sp.redirect_status === "failed";
  const isPending = Boolean(order) && !isPaid && !isFailed;

  const title = isPaid
    ? t("headingPaid")
    : isFailed
      ? t("headingFailed")
      : isPending
      ? t("headingProcessing")
      : hasLookup
        ? t("headingPending")
        : t("headingMissing");

  const description = isPaid
    ? t("subPaid")
    : isFailed
      ? t("subFailed")
      : isPending
      ? t("subProcessing")
      : hasLookup
        ? lookupError
          ? t("subFetchFailed")
          : t("subPending")
        : t("subMissing");

  const view: SuccessOrder | null = order
    ? {
        id: String(order.id),
        createdAt: order.created_at ? new Date(order.created_at).toISOString() : null,
        totalCents: order.total_ron != null ? Math.round(Number(order.total_ron) * 100) : null,
        currency: String(order.currency || "RON").trim().toUpperCase(),
        customerEmail: order.customer_email || null,
      }
    : null;
  const viewItems = (Array.isArray(items) ? items : []).map((item: { title?: string; quantity?: number; price?: number | string; priceCents?: number }) => ({
    title: String(item.title || ""),
    quantity: Number(item.quantity) || 1,
    priceCents: item.priceCents != null ? Number(item.priceCents) : Math.round(Number(item.price || 0) * 100),
  }));

  return (
    <SuccessView
      title={title}
      description={description}
      isPaid={isPaid}
      isPending={isPending}
      isFailed={isFailed}
      showDetails={pii_ok}
      order={view}
      items={viewItems}
      shipping={shipping}
    />
  );
}
