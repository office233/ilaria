/**
 * Istoricul de comenzi al cumpărătorului (doar comenzile lui — `buyer_user_id`).
 * Comenzile `pending` înlocuite de alt checkout (anulate cu motivul
 * superseded_by_cart_change) nu sunt afișate: sunt artefacte tehnice.
 */
import { dbQuery } from "@/lib/db";
import { UUID_RE } from "@/lib/validation/uuid";
import { VERIFIED_ORDER_STATUSES } from "./reviews";

export type BuyerOrderSummary = {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  createdAt: string;
  itemCount: number;
  firstImage: string | null;
  firstTitle: string | null;
};

const HIDDEN = `NOT (o.status = 'cancelled' AND o.metadata->>'cancel_reason' = 'superseded_by_cart_change')`;

export function encodeOrderCursor(o: { createdAt: string; id: string }): string {
  return Buffer.from(`${o.createdAt}|${o.id}`, "utf8").toString("base64url");
}

/** Timestamp Postgres (`timestamptz::text`) sau ISO — validat înainte de a ajunge în SQL. */
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function decodeOrderCursor(raw: string | undefined): { createdAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const [createdAt, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!id || !UUID_RE.test(id) || !TS_RE.test(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function listBuyerOrders(
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ orders: BuyerOrderSummary[]; nextCursor: string | null }> {
  const cursor = decodeOrderCursor(opts.cursor);
  const { rows } = await dbQuery<{
    id: string;
    status: string;
    total_cents: number;
    currency: string;
    created_at: string;
    cursor_ts: string;
    item_count: number;
    first_image: string | null;
    first_title: string | null;
  }>(
    `SELECT o.id::text AS id, o.status, o.total_cents, o.currency, o.created_at, o.created_at::text AS cursor_ts,
            (SELECT COALESCE(SUM(oi.quantity), 0)::int FROM commerce_order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT mp.image_url FROM commerce_order_items oi LEFT JOIN marketplace_products mp ON mp.id = oi.product_id
              WHERE oi.order_id = o.id ORDER BY oi.created_at LIMIT 1) AS first_image,
            (SELECT oi.title FROM commerce_order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at LIMIT 1) AS first_title
       FROM commerce_orders o
      WHERE o.buyer_user_id = $1 AND ${HIDDEN}
        AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $4`,
    [userId, cursor?.createdAt ?? null, cursor?.id ?? null, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  const orders = page.map((r) => ({
    id: r.id,
    status: r.status,
    totalCents: Number(r.total_cents),
    currency: String(r.currency || "RON").trim().toUpperCase(),
    createdAt: new Date(r.created_at).toISOString(),
    itemCount: Number(r.item_count) || 0,
    firstImage: r.first_image,
    firstTitle: r.first_title,
  }));
  // Cursorul folosește timestamp-ul exact din DB (microsecunde), nu ISO-ul rotunjit la ms.
  const last = page[page.length - 1];
  return {
    orders,
    nextCursor: rows.length > opts.limit && last ? encodeOrderCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
  };
}

export type BuyerOrderItem = {
  id: string;
  productId: string | null;
  title: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  image: string | null;
  reviewed: boolean;
};

export type BuyerOrderDetail = {
  id: string;
  status: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
  createdAt: string;
  lookupToken: string | null;
  trackingUrl: string | null;
  trackingNumber: string | null;
  shipping: { name?: string; line1?: string; city?: string; postal_code?: string; country?: string } | null;
  canReview: boolean;
  items: BuyerOrderItem[];
};

export async function getBuyerOrder(userId: string, orderId: string): Promise<BuyerOrderDetail | null> {
  if (!UUID_RE.test(orderId)) return null;
  const { rows } = await dbQuery<{
    id: string;
    status: string;
    subtotal_cents: number;
    shipping_cents: number;
    tax_cents: number;
    discount_cents: number;
    total_cents: number;
    currency: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id::text AS id, status, subtotal_cents, shipping_cents, tax_cents, discount_cents,
            total_cents, currency, created_at, metadata
       FROM commerce_orders
      WHERE id = $1::uuid AND buyer_user_id = $2
      LIMIT 1`,
    [orderId, userId],
  );
  const o = rows[0];
  if (!o) return null;
  const { rows: items } = await dbQuery<{
    id: string;
    product_id: string | null;
    title: string;
    quantity: number;
    unit_amount_cents: number;
    gross_amount_cents: number;
    image: string | null;
    reviewed: boolean;
  }>(
    `SELECT oi.id::text AS id, oi.product_id::text AS product_id, oi.title, oi.quantity,
            oi.unit_amount_cents, oi.gross_amount_cents, mp.image_url AS image,
            EXISTS (SELECT 1 FROM product_reviews r WHERE r.product_id = oi.product_id AND r.user_id = $2) AS reviewed
       FROM commerce_order_items oi
       LEFT JOIN marketplace_products mp ON mp.id = oi.product_id
      WHERE oi.order_id = $1::uuid
      ORDER BY oi.created_at`,
    [orderId, userId],
  );
  const md = o.metadata ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: o.id,
    status: o.status,
    subtotalCents: Number(o.subtotal_cents),
    shippingCents: Number(o.shipping_cents),
    taxCents: Number(o.tax_cents),
    discountCents: Number(o.discount_cents),
    totalCents: Number(o.total_cents),
    currency: String(o.currency || "RON").trim().toUpperCase(),
    createdAt: new Date(o.created_at).toISOString(),
    lookupToken: str(md.order_lookup_token),
    trackingUrl: str(md.tracking_url) ?? str(md.latest_tracking_url),
    trackingNumber: str(md.tracking_number) ?? str(md.latest_tracking_number),
    shipping: (md.shipping_address as BuyerOrderDetail["shipping"]) ?? null,
    canReview: (VERIFIED_ORDER_STATUSES as readonly string[]).includes(o.status),
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      title: i.title,
      quantity: Number(i.quantity),
      unitCents: Number(i.unit_amount_cents),
      lineCents: Number(i.gross_amount_cents),
      image: i.image,
      reviewed: Boolean(i.reviewed),
    })),
  };
}

/** Statusurile cu etichetă proprie (restul cad pe `pending`). */
export const ORDER_STATUS_KEYS = [
  "pending",
  "authorized",
  "paid",
  "fulfilled",
  "delivered",
  "cancelled",
  "refunded",
  "failed",
  "return_requested",
] as const;

export function orderStatusKey(status: string): (typeof ORDER_STATUS_KEYS)[number] {
  return (ORDER_STATUS_KEYS as readonly string[]).includes(status) ? (status as (typeof ORDER_STATUS_KEYS)[number]) : "pending";
}

export function orderStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "delivered" || status === "paid") return "success";
  if (status === "fulfilled" || status === "authorized") return "info";
  if (status === "cancelled" || status === "failed" || status === "refunded") return "danger";
  if (status === "return_requested") return "warning";
  return "neutral";
}
