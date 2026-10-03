import { dbQuery } from "@/lib/db";
import { PLATFORM_COMMISSION_BPS, applyBps } from "@/lib/config/commerce";
import { sendSellerNewOrderAlert } from "@/lib/email/service";
import { notifyOps } from "@/lib/ops/alerts";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "order-router" });

export type OrderItemMetadata = {
  seller_id?: string;
  source?: string;
  pgId?: string;
  pg_id?: string;
  product_id?: string;
  skuId?: string;
  sku_id?: string;
  stripe_line_item_id?: string;
  swypik_commission_cents?: number;
  seller_payout_cents?: number;
  [key: string]: unknown;
};

export type OrderItem = {
  productId: string;
  skuId?: string;
  title: string;
  quantity: number;
  price: number;
  image?: string;
  metadata?: OrderItemMetadata;
  /** Stripe line item id, when the item literally came off a Stripe line-item object. */
  id?: string;
};

export type FulfillmentPlan = {
  /** Iteme fără seller — necesită procesare manuală de către admin. */
  manual: OrderItem[];
  localSellers: Record<string, OrderItem[]>;
};

/**
 * routeOrder direcționează itemele unei comenzi plătite: către selleri
 * (pending_seller_action) sau, fără seller, către coada manuală a adminului.
 * Nu mai există dropshipping/furnizori externi.
 */
export async function routeOrder(orderId: string, items: OrderItem[]): Promise<FulfillmentPlan> {
  const plan: FulfillmentPlan = {
    manual: [],
    localSellers: {},
  };

  const updates: Promise<{ rows: unknown[]; rowCount: number }>[] = [];

  /** Iteme plătite pentru care nu există cheie de corelare — vezi alerta de mai jos. */
  const orphanItems: OrderItem[] = [];

  for (const item of items) {
    const sellerId = item.metadata?.seller_id;
    const source = item.metadata?.source || "manual";

    if (sellerId) {
      if (!plan.localSellers[sellerId]) plan.localSellers[sellerId] = [];
      plan.localSellers[sellerId].push(item);
    } else {
      plan.manual.push(item);
    }

    const sourceStatus = sellerId ? 'pending_seller_action' : 'pending';

    // Build a unique key matching the row inserted by persistOrderItems()
    // in webhooks/stripe/route.ts: external_line_item_id = "${pgId}:${skuId || 'default'}".
    // The previous implementation matched on (li.id OR title) — li.id never matched
    // and title-fallback updated all rows sharing the same product title.
    const pgId = item.metadata?.pgId
      || item.metadata?.pg_id
      || item.metadata?.product_id
      || item.productId;
    const sku = item.skuId || item.metadata?.skuId || item.metadata?.sku_id || "default";
    const externalLineItemId = pgId ? `${pgId}:${sku}` : null;
    const stripeLineItemId = item.id || item.metadata?.stripe_line_item_id || null;

    if (!externalLineItemId && !stripeLineItemId) {
      // 2026-08-15 (audit, ÎNALT): aici era `console.warn` + `continue`.
      // Itemul e DEJA PLĂTIT (routeOrder rulează după confirmarea Stripe), dar
      // fără cheie de corelare nu-i putem seta `source_status` → rămâne orfan:
      // clientul a plătit, produsul nu pleacă spre niciun seller și nimeni nu
      // află. Un `console.warn` într-un log rotit nu e un mecanism de alertare.
      // Acum: log critic structurat + alertă ops persistată în `ops_alert_log`
      // (DLQ-ul nostru) și trimisă pe webhook, cu tot ce trebuie pentru
      // reconciliere manuală.
      orphanItems.push(item);
      log.error(
        {
          order_id: orderId,
          title: item.title,
          product_id: item.productId,
          sku_id: item.skuId ?? null,
          quantity: item.quantity,
          price: item.price,
          seller_id: sellerId ?? null,
        },
        "ITEM PLĂTIT ORFAN: lipsesc și external_line_item_id, și stripe_line_item_id — necesită reconciliere manuală",
      );
      continue;
    }

    let query: string;
    let params: Array<string | number | null>;

    if (source === "local" || sourceStatus === 'pending_seller_action') {
      const unit_amount_cents = Math.round(item.price * 100);
      const gross_amount_cents = unit_amount_cents * item.quantity;
      const swypik_commission_cents = applyBps(gross_amount_cents, PLATFORM_COMMISSION_BPS);
      const seller_payout_cents = gross_amount_cents - swypik_commission_cents;

      if (!item.metadata) item.metadata = {};
      item.metadata.swypik_commission_cents = swypik_commission_cents;
      item.metadata.seller_payout_cents = seller_payout_cents;

      query = `UPDATE commerce_order_items
         SET source_status = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
         WHERE order_id = $2
           AND (
             external_line_item_id = $3
             OR metadata->>'stripe_line_item_id' = $5
           )`;
      params = [
        sourceStatus,
        orderId,
        externalLineItemId,
        JSON.stringify({ swypik_commission_cents, seller_payout_cents }),
        stripeLineItemId,
      ];
    } else {
      query = `UPDATE commerce_order_items
         SET source_status = $1
         WHERE order_id = $2
           AND (
             external_line_item_id = $3
             OR metadata->>'stripe_line_item_id' = $4
           )`;
      params = [sourceStatus, orderId, externalLineItemId, stripeLineItemId];
    }

    updates.push(dbQuery(query, params));
  }

  // Alertă unică per comandă, nu una per item — cooldown-ul din notifyOps e pe
  // `key`, iar orderId e stabil, deci reîncercările nu spamează canalul.
  if (orphanItems.length > 0) {
    await notifyOps({
      key: `order_orphan_items:${orderId}`,
      severity: "critical",
      title: `Comandă plătită cu ${orphanItems.length} item(e) orfan(e)`,
      detail:
        `Comanda ${orderId} conține iteme fără external_line_item_id și fără ` +
        `stripe_line_item_id. Nu li s-a putut seta source_status, deci NU vor ` +
        `ajunge la niciun seller și nu apar în coada manuală de fulfillment.\n\n` +
        orphanItems
          .map((it) => `• ${it.title} ×${it.quantity} (product_id=${it.productId})`)
          .join("\n"),
      link: `/admin/orders/${orderId}`,
      payload: {
        order_id: orderId,
        orphan_count: orphanItems.length,
        items: orphanItems.map((it) => ({
          title: it.title,
          product_id: it.productId,
          sku_id: it.skuId ?? null,
          quantity: it.quantity,
          price: it.price,
        })),
      },
    }).catch((err) => {
      // Alerta nu trebuie să arunce mai departe — comanda e deja plătită și
      // restul rutării trebuie să continue. Dar eșecul ei se loghează.
      log.error({ err, order_id: orderId }, "nu am putut trimite alerta pentru iteme orfane");
    });
  }

  try {
    await Promise.all(updates);
  } catch (dbErr) {
    // 2026-08-15 (audit): eșecul aici lasă itemele fără `source_status`, deci
    // invizibile pentru fulfillment — aceeași consecință ca itemele orfane.
    log.error({ err: dbErr, order_id: orderId }, "eșec la actualizarea source_status — iteme posibil neprocesate");
    await notifyOps({
      key: `order_status_update_failed:${orderId}`,
      severity: "critical",
      title: "Eșec la marcarea itemelor unei comenzi plătite",
      detail:
        `UPDATE-ul de source_status a eșuat pentru comanda ${orderId}. ` +
        `Itemele pot rămâne neprocesate. Verifică manual starea comenzii.`,
      link: `/admin/orders/${orderId}`,
      payload: { order_id: orderId, error: String(dbErr) },
    }).catch((err) => {
      log.error({ err, order_id: orderId }, "nu am putut trimite alerta pentru eșecul de update");
    });
  }

  let customerName = 'X';
  try {
    const { rows: orderRows } = await dbQuery(
      `SELECT metadata->'shipping_address'->>'name' AS customer_name FROM commerce_orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );
    if (orderRows.length > 0 && orderRows[0].customer_name) {
      customerName = orderRows[0].customer_name;
    }
  } catch (err) {
    logger.error({ err }, `[Order Router] Error fetching customer name`);
  }

  for (const [sellerId, sellerItems] of Object.entries(plan.localSellers)) {
    try {
      const { rows } = await dbQuery(`SELECT email FROM sellers WHERE id = $1 LIMIT 1`, [sellerId]);
      if (rows.length > 0 && rows[0].email) {
        const sellerEmail = rows[0].email;
        log.info({ seller_id: sellerId, order_id: orderId, items_count: sellerItems.length }, "sending new order alert to seller");
        await sendSellerNewOrderAlert(sellerEmail, sellerItems, customerName);
      } else {
        logger.warn(`[Order Router] Seller ${sellerId} not found or has no email.`);
      }
    } catch (err) {
      logger.error({ err }, `[Order Router] Failed to send seller alert for ${sellerId}`);
    }
  }

  return plan;
}
