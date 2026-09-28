/**
 * Comenzile unui seller (doar item-urile lui dintr-o comandă multi-seller),
 * cu starea din lib/seller/fulfilment.ts, paginate și filtrate pe tab.
 *
 * Filtrarea pe tab se face în SQL (expresia `state` de mai jos oglindește
 * deriveSellerOrderState), dar starea returnată și acțiunile permise se
 * calculează în JS din item-uri — o singură sursă pentru UI și pentru validarea
 * tranzițiilor din /api/seller/orders/[id]/status.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import {
  SELLER_ORDER_TABS,
  allowedSellerActions,
  deriveSellerOrderState,
  type SellerOrderAction,
  type SellerOrderState,
  type SellerOrderTab,
} from "./fulfilment";

type ItemMeta = {
  tracking_number?: string;
  tracking_url?: string;
  carrier?: string;
  seller_accepted_at?: string;
  delivered_at?: string;
} | null;

type OrderMeta = {
  tracking_number?: string;
  tracking_url?: string;
  latest_tracking_number?: string;
  latest_tracking_url?: string;
  tracking_carrier?: string;
  shipping_method?: string;
  delivery_method?: string;
  shipping_address?: Record<string, string | undefined> | null;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  easybox_locker?: string;
  awb_details?: { awb_number?: string; carrier?: string; tracking_url?: string; locker_name?: string } | null;
  return_reason?: string;
  return_requested_at?: string;
} | null;

type Row = {
  order_id: string;
  order_status: string;
  order_meta: OrderMeta;
  currency: string | null;
  created_at: string;
  total_cents: string | number;
  items: Array<{
    item_id: string;
    title: string;
    quantity: number;
    unit_amount_cents: number;
    metadata: ItemMeta;
    source_status: string | null;
  }> | null;
};

export type SellerOrderView = ReturnType<typeof toView>;

/** Expresia SQL a stării (oglinda lui deriveSellerOrderState). */
const STATE_SQL = `
  CASE
    WHEN co.status = 'refunded' THEN 'refunded'
    WHEN co.status = 'return_requested' THEN 'return_requested'
    WHEN co.status = 'cancelled' THEN 'cancelled'
    WHEN co.status IN ('pending', 'authorized', 'failed') THEN 'awaiting_payment'
    WHEN m.n_cancelled = m.n THEN 'cancelled'
    WHEN m.n_fulfilled = m.n - m.n_cancelled
      THEN CASE WHEN co.status = 'delivered' OR m.n_delivered = m.n - m.n_cancelled THEN 'delivered' ELSE 'shipped' END
    WHEN m.n_accepted > 0 THEN 'accepted'
    ELSE 'new'
  END`;

const MINE_SQL = `
  WITH m AS (
    SELECT coi.order_id,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE coi.source_status = 'cancelled')::int AS n_cancelled,
           COUNT(*) FILTER (WHERE coi.source_status = 'fulfilled')::int AS n_fulfilled,
           COUNT(*) FILTER (WHERE coi.source_status <> 'cancelled' AND coi.metadata ? 'delivered_at')::int AS n_delivered,
           COUNT(*) FILTER (WHERE coi.source_status <> 'cancelled' AND coi.metadata ? 'seller_accepted_at')::int AS n_accepted,
           COALESCE(SUM(coi.quantity * coi.unit_amount_cents) FILTER (WHERE coi.source_status <> 'cancelled'), 0) AS total_cents,
           json_agg(json_build_object(
             'item_id', coi.id, 'title', coi.title, 'quantity', coi.quantity,
             'unit_amount_cents', coi.unit_amount_cents, 'metadata', coi.metadata,
             'source_status', coi.source_status
           ) ORDER BY coi.created_at) AS items
      FROM commerce_order_items coi
     WHERE coi.metadata->>'seller_id' = $1
     GROUP BY coi.order_id
  ), s AS (
    SELECT co.id AS order_id, co.status AS order_status, co.metadata AS order_meta, co.currency,
           co.created_at, m.total_cents, m.items, ${STATE_SQL} AS state
      FROM m JOIN commerce_orders co ON co.id = m.order_id
  )`;

function toView(row: Row, returnsEnabled: boolean) {
  const items = row.items ?? [];
  const meta = row.order_meta ?? {};
  const state: SellerOrderState = deriveSellerOrderState(row.order_status, items);
  const itemTracking = items.find((i) => i.metadata?.tracking_number)?.metadata;
  const trackingNumber =
    itemTracking?.tracking_number || meta.awb_details?.awb_number || meta.tracking_number || meta.latest_tracking_number || null;
  const trackingUrl =
    itemTracking?.tracking_url || meta.awb_details?.tracking_url || meta.tracking_url || meta.latest_tracking_url || null;
  const carrier = itemTracking?.carrier || meta.tracking_carrier || meta.awb_details?.carrier || null;
  const actions: SellerOrderAction[] = allowedSellerActions(state, { returnsEnabled });
  return {
    order_id: row.order_id,
    order_status: row.order_status,
    state,
    status: state,
    actions,
    currency: (row.currency || "RON").trim(),
    created_at: row.created_at,
    total_cents: Number(row.total_cents || 0),
    items,
    order_metadata: {
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      tracking_carrier: carrier,
      shipping_method: meta.shipping_method || meta.delivery_method || carrier,
      shipping_address: meta.shipping_address ?? null,
      customer_name: meta.shipping_address?.name || meta.customer_name || null,
      customer_email: meta.customer_email || null,
      customer_phone: meta.customer_phone || meta.shipping_address?.phone || null,
      easybox_locker: meta.easybox_locker || meta.awb_details?.locker_name || null,
      awb_details: meta.awb_details ?? null,
      return_reason: meta.return_reason || null,
      return_requested_at: meta.return_requested_at || null,
    },
  };
}

export type ListSellerOrdersArgs = { tab: SellerOrderTab; limit: number; offset: number; q: string | null };

export async function listSellerOrders(sellerId: string, args: ListSellerOrdersArgs) {
  const states = args.tab === "all" ? null : [...SELLER_ORDER_TABS[args.tab]];
  const q = args.q?.trim() ? args.q.trim().slice(0, 80) : null;
  const { rows } = await dbQuery<Row>(
    `${MINE_SQL}
     SELECT order_id, order_status, order_meta, currency, created_at, total_cents, items
       FROM s
      WHERE state <> 'awaiting_payment'
        AND ($2::text[] IS NULL OR state = ANY($2::text[]))
        AND ($3::text IS NULL
             OR order_id::text ILIKE $3 || '%'
             OR order_meta->>'customer_email' ILIKE '%' || $3 || '%'
             OR order_meta->'shipping_address'->>'name' ILIKE '%' || $3 || '%')
      ORDER BY created_at DESC, order_id
      LIMIT $4 OFFSET $5`,
    [sellerId, states, q, args.limit + 1, args.offset],
  );
  const returnsEnabled = isEnabled("returns");
  return {
    orders: rows.slice(0, args.limit).map((r) => toView(r, returnsEnabled)),
    hasMore: rows.length > args.limit,
  };
}

/** Numărul de comenzi per tab (badge-uri). */
export async function countSellerOrdersByTab(sellerId: string): Promise<Record<SellerOrderTab, number>> {
  const { rows } = await dbQuery<{ state: SellerOrderState; n: string | number }>(
    `${MINE_SQL}
     SELECT state, COUNT(*)::int AS n FROM s WHERE state <> 'awaiting_payment' GROUP BY state`,
    [sellerId],
  );
  const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
  const sum = (states: readonly SellerOrderState[]) => states.reduce((acc, s) => acc + (by.get(s) ?? 0), 0);
  return {
    all: [...by.values()].reduce((a, b) => a + b, 0),
    todo: sum(SELLER_ORDER_TABS.todo),
    shipped: sum(SELLER_ORDER_TABS.shipped),
    done: sum(SELLER_ORDER_TABS.done),
    issues: sum(SELLER_ORDER_TABS.issues),
  };
}

/** O comandă a seller-ului (null = nu există / nu are item-uri ale lui). */
export async function getSellerOrder(sellerId: string, orderId: string) {
  const { rows } = await dbQuery<Row>(
    `${MINE_SQL}
     SELECT order_id, order_status, order_meta, currency, created_at, total_cents, items
       FROM s WHERE order_id = $2::uuid`,
    [sellerId, orderId],
  );
  return rows[0] ? toView(rows[0], isEnabled("returns")) : null;
}
