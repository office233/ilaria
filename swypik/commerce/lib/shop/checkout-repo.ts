/**
 * Acces DB pentru checkout — toate funcțiile rulează în tranzacția deschisă de
 * apelant (`withTransaction`), ca blocarea stocului și inserarea comenzii să fie
 * atomice.
 */
import type { TxQuery } from "@/lib/db";
import { UUID_RE } from "@/lib/validation/uuid";
import type { LineInput, PricedCart, PricingProduct, PricingVariant } from "./pricing";
import { stockKey } from "./pricing";

type CartLineRow = {
  product_id: string | null;
  variant_id: string | null;
  quantity: number;
  video_id: string | null;
};

export async function loadCartLines(q: TxQuery, cartId: string): Promise<LineInput[]> {
  const { rows } = await q<CartLineRow>(
    `SELECT COALESCE(ci.marketplace_product_id::text, ci.external_product_id) AS product_id,
            ci.marketplace_variant_id::text AS variant_id,
            ci.quantity,
            ci.video_id::text AS video_id
       FROM cart_items ci
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at`,
    [cartId],
  );
  return rows
    .filter((r) => r.product_id && UUID_RE.test(r.product_id))
    .map((r) => ({
      productId: String(r.product_id),
      variantId: r.variant_id,
      quantity: Number(r.quantity),
      videoId: r.video_id,
    }));
}

type ProductRow = {
  id: string;
  title: string;
  price_cents: number | null;
  currency: string;
  listing_type: string | null;
  purchasable: boolean;
  stock: string | null;
  seller_id: string | null;
};

/** Blochează rândurile produselor (FOR UPDATE) — checkout-urile concurente pe același produs se serializează. */
export async function lockProducts(q: TxQuery, ids: string[]): Promise<Map<string, PricingProduct>> {
  const { rows } = await q<ProductRow>(
    `SELECT p.id::text AS id, p.title, p.price_cents, p.currency, p.listing_type,
            (p.status = 'active' AND COALESCE(p.is_adult, false) = false AND p.effective_label = 'safe') AS purchasable,
            NULLIF(p.metadata->>'available_stock', '') AS stock,
            p.seller_id::text AS seller_id
       FROM marketplace_products p
      WHERE p.id = ANY($1::uuid[])
      ORDER BY p.id
      FOR UPDATE`,
    [ids],
  );
  const map = new Map<string, PricingProduct>();
  for (const r of rows) {
    const stock = r.stock == null ? null : Number(r.stock);
    map.set(r.id, {
      id: r.id,
      title: r.title,
      priceCents: r.price_cents == null ? null : Number(r.price_cents),
      currency: String(r.currency || "RON").trim().toUpperCase(),
      stock: stock != null && Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : null,
      listingType: r.listing_type || "product",
      purchasable: Boolean(r.purchasable),
      sellerId: r.seller_id,
    });
  }
  return map;
}

export async function loadVariants(q: TxQuery, productIds: string[]): Promise<PricingVariant[]> {
  const { rows } = await q<{
    id: string;
    product_id: string;
    title: string | null;
    price_cents: number | null;
    inventory_quantity: number | null;
    status: string;
  }>(
    `SELECT id::text AS id, product_id::text AS product_id, title, price_cents, inventory_quantity, status
       FROM marketplace_product_variants
      WHERE product_id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [productIds],
  );
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    title: r.title,
    priceCents: r.price_cents == null ? null : Number(r.price_cents),
    stock: r.inventory_quantity == null ? null : Number(r.inventory_quantity),
    status: r.status,
  }));
}

/** Cantitățile ținute de alte comenzi neplătite, încă în fereastra de rezervare. */
export async function loadReserved(
  q: TxQuery,
  productIds: string[],
  excludeOrderId: string | null,
): Promise<Map<string, number>> {
  const { rows } = await q<{ product_id: string; variant_id: string | null; qty: number }>(
    `SELECT oi.product_id::text AS product_id, oi.variant_id::text AS variant_id, SUM(oi.quantity)::int AS qty
       FROM commerce_order_items oi
       JOIN commerce_orders o ON o.id = oi.order_id
      WHERE o.status = 'pending'
        AND o.reserved_until > now()
        AND oi.product_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR o.id <> $2::uuid)
      GROUP BY 1, 2`,
    [productIds, excludeOrderId],
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(stockKey(r.product_id, r.variant_id), Number(r.qty) || 0);
  return map;
}

export type PendingOrder = {
  id: string;
  fingerprint: string | null;
  paymentIntentId: string | null;
  lookupToken: string | null;
  totalCents: number;
};

export async function findPendingOrderForCart(q: TxQuery, cartId: string): Promise<PendingOrder | null> {
  const { rows } = await q<{
    id: string;
    total_cents: number;
    fingerprint: string | null;
    pi: string | null;
    token: string | null;
  }>(
    `SELECT id::text AS id, total_cents,
            metadata->>'cart_fingerprint' AS fingerprint,
            metadata->>'stripe_payment_intent' AS pi,
            metadata->>'order_lookup_token' AS token
       FROM commerce_orders
      WHERE status = 'pending' AND metadata->>'cart_id' = $1
      LIMIT 1
      FOR UPDATE`,
    [cartId],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, fingerprint: r.fingerprint, paymentIntentId: r.pi, lookupToken: r.token, totalCents: Number(r.total_cents) };
}

export async function extendReservation(q: TxQuery, orderId: string, minutes: number): Promise<void> {
  await q(
    `UPDATE commerce_orders SET reserved_until = now() + make_interval(mins => $2) WHERE id = $1`,
    [orderId, minutes],
  );
}

/** Coșul s-a schimbat: comanda veche nu mai e validă, eliberăm rezervarea și cheia unică pe coș. */
export async function supersedeOrder(q: TxQuery, orderId: string): Promise<void> {
  await q(
    `UPDATE commerce_orders
        SET status = 'cancelled', cancelled_at = now(), reserved_until = NULL,
            metadata = metadata || '{"cancel_reason":"superseded_by_cart_change"}'::jsonb
      WHERE id = $1 AND status = 'pending'`,
    [orderId],
  );
}

export type NewOrderInput = {
  buyerUserId: string;
  customerEmail: string | null;
  cartId: string;
  priced: PricedCart;
  attribution: Map<string, { creatorId?: string; videoId?: string; creatorProductLinkId?: string }>;
  lookupToken: string;
  reservationMinutes: number;
  ipCountry: string | null;
  userAgent: string | null;
};

export async function insertOrder(q: TxQuery, input: NewOrderInput): Promise<string> {
  const { priced } = input;
  const { rows } = await q<{ id: string }>(
    `INSERT INTO commerce_orders (
       buyer_user_id, status, currency, subtotal_cents, shipping_cents, total_cents, reserved_until, metadata
     ) VALUES ($1, 'pending', $2, $3, $4, $5, now() + make_interval(mins => $6), $7::jsonb)
     RETURNING id::text AS id`,
    [
      input.buyerUserId,
      priced.currency,
      priced.subtotalCents,
      priced.shippingCents,
      priced.totalCents,
      input.reservationMinutes,
      JSON.stringify({
        source: "embedded_checkout",
        cart_id: input.cartId,
        cart_fingerprint: priced.fingerprint,
        customer_email: input.customerEmail,
        order_lookup_token: input.lookupToken,
        item_count: priced.lines.reduce((s, l) => s + l.quantity, 0),
        checkout_ip_country: input.ipCountry,
        checkout_user_agent: input.userAgent,
        checkout_at: new Date().toISOString(),
      }),
    ],
  );
  const orderId = rows[0].id;
  for (const line of priced.lines) {
    const attr = input.attribution.get(line.productId) ?? {};
    await q(
      `INSERT INTO commerce_order_items (
         order_id, product_id, variant_id, creator_id, video_id, creator_product_link_id,
         external_line_item_id, title, quantity, currency, unit_amount_cents,
         gross_amount_cents, commissionable_amount_cents, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13::jsonb)`,
      [
        orderId,
        line.productId,
        line.variantId,
        attr.creatorId ?? null,
        attr.videoId ?? null,
        attr.creatorProductLinkId ?? null,
        `${line.productId}:${line.variantId ?? "default"}`,
        line.title,
        line.quantity,
        line.currency,
        line.unitCents,
        line.lineCents,
        JSON.stringify({
          source: "embedded_checkout",
          product_id: line.productId,
          variant_id: line.variantId,
          seller_id: line.sellerId,
          video_id: attr.videoId ?? null,
          creator_id: attr.creatorId ?? null,
        }),
      ],
    );
  }
  return orderId;
}
