import { withTransaction, type TxQuery } from "@/lib/db";
import type { CatalogConnection, ExternalOrder, OrderPage } from "./types";
import { CatalogProviderError } from "./common";

export type OrderSyncResult = {
  inspected: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ externalId: string; code: string }>;
};

async function syncItems(
  q: TxQuery,
  orderId: string,
  order: ExternalOrder,
): Promise<void> {
  const externalIds: string[] = [];
  for (const item of order.items) {
    externalIds.push(item.externalId);
    await q(
      `INSERT INTO seller_imported_order_items
         (order_id, external_line_item_id, external_product_id, external_variant_id,
          title, sku, quantity, currency, unit_amount_cents, total_amount_cents, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (order_id, external_line_item_id)
       DO UPDATE SET external_product_id = EXCLUDED.external_product_id,
                     external_variant_id = EXCLUDED.external_variant_id,
                     title = EXCLUDED.title,
                     sku = EXCLUDED.sku,
                     quantity = EXCLUDED.quantity,
                     currency = EXCLUDED.currency,
                     unit_amount_cents = EXCLUDED.unit_amount_cents,
                     total_amount_cents = EXCLUDED.total_amount_cents,
                     metadata = EXCLUDED.metadata,
                     updated_at = now()`,
      [
        orderId,
        item.externalId,
        item.externalProductId,
        item.externalVariantId,
        item.title,
        item.sku,
        item.quantity,
        item.currency,
        item.unitAmountCents,
        item.totalAmountCents,
        JSON.stringify(item.metadata),
      ],
    );
  }

  if (order.itemsComplete) {
    await q(
      `DELETE FROM seller_imported_order_items
        WHERE order_id = $1
          AND NOT (external_line_item_id = ANY($2::text[]))`,
      [orderId, externalIds],
    );
  }
}

async function syncOneOrder(
  connection: CatalogConnection,
  order: ExternalOrder,
): Promise<"created" | "updated"> {
  return withTransaction(async (q) => {
    const { rows } = await q<{ id: string; inserted: boolean }>(
      `INSERT INTO seller_imported_orders
         (seller_id, integration_id, provider, external_account_id, external_order_id,
          order_number, normalized_status, provider_status, financial_status,
          fulfillment_status, currency, subtotal_cents, discount_cents, shipping_cents,
          tax_cents, total_cents, refunded_cents, customer_external_id, customer_name,
          customer_email, customer_phone, placed_at, cancelled_at, metadata, last_synced_at)
       VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, now()
       )
       ON CONFLICT (seller_id, provider, external_account_id, external_order_id)
       DO UPDATE SET integration_id = EXCLUDED.integration_id,
                     order_number = EXCLUDED.order_number,
                     normalized_status = EXCLUDED.normalized_status,
                     provider_status = EXCLUDED.provider_status,
                     financial_status = EXCLUDED.financial_status,
                     fulfillment_status = EXCLUDED.fulfillment_status,
                     currency = EXCLUDED.currency,
                     subtotal_cents = EXCLUDED.subtotal_cents,
                     discount_cents = EXCLUDED.discount_cents,
                     shipping_cents = EXCLUDED.shipping_cents,
                     tax_cents = EXCLUDED.tax_cents,
                     total_cents = EXCLUDED.total_cents,
                     refunded_cents = EXCLUDED.refunded_cents,
                     customer_external_id = EXCLUDED.customer_external_id,
                     customer_name = EXCLUDED.customer_name,
                     customer_email = EXCLUDED.customer_email,
                     customer_phone = EXCLUDED.customer_phone,
                     placed_at = EXCLUDED.placed_at,
                     cancelled_at = EXCLUDED.cancelled_at,
                     metadata = EXCLUDED.metadata,
                     last_synced_at = now(),
                     updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        connection.sellerId,
        connection.id,
        connection.provider,
        connection.externalAccountId,
        order.externalId,
        order.orderNumber,
        order.normalizedStatus,
        order.providerStatus,
        order.financialStatus,
        order.fulfillmentStatus,
        order.currency,
        order.subtotalCents,
        order.discountCents,
        order.shippingCents,
        order.taxCents,
        order.totalCents,
        order.refundedCents,
        order.customerExternalId,
        order.customerName,
        order.customerEmail,
        order.customerPhone,
        order.placedAt,
        order.cancelledAt,
        JSON.stringify(order.metadata),
      ],
    );
    const row = rows[0];
    if (!row?.id) throw new CatalogProviderError("order_sync_failed", 500);
    await syncItems(q, row.id, order);
    return row.inserted ? "created" : "updated";
  });
}

export async function syncOrderPage(
  connection: CatalogConnection,
  page: OrderPage,
): Promise<OrderSyncResult> {
  const result: OrderSyncResult = {
    inspected: page.orders.length,
    created: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  for (const order of page.orders) {
    try {
      const outcome = await syncOneOrder(connection, order);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        externalId: order.externalId,
        code: error instanceof CatalogProviderError ? error.code : "order_sync_failed",
      });
    }
  }
  return result;
}
