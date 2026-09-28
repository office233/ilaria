/**
 * Expedierea item-urilor unui seller (AWB introdus de seller, de la curier).
 * Folosită de POST /api/seller/orders (tracking simplu) și de
 * POST /api/seller/orders/[id]/awb (curier + AWB) — înainte fiecare rută avea
 * propria copie a acestor 5 pași.
 *
 *  1. item-urile seller-ului (necanceled) → source_status 'fulfilled' + tracking
 *  2. supplier_orders (seller) → 'shipped'
 *  3. fulfillment_shipments (o singură înregistrare per AWB)
 *  4. comanda → 'fulfilled' când nu mai rămân item-uri de expediat
 *  5. email de tracking către cumpărător (best-effort)
 */
import { dbQuery } from "@/lib/db";
import { sendCustomerShippingAlert } from "@/lib/email/service";
import { logger } from "@/lib/logger";

export type SellerShipmentInput = {
  orderId: string;
  sellerId: string;
  trackingNumber: string;
  trackingUrl: string | null;
  carrier: string | null;
  customerEmail: string | null;
  /** Câmpuri suplimentare scrise în commerce_orders.metadata (ex. awb_details). */
  orderMetaExtra?: Record<string, unknown>;
};

export async function recordSellerShipment(input: SellerShipmentInput): Promise<{ remainingItems: number }> {
  const { orderId, sellerId, trackingNumber, trackingUrl, carrier } = input;

  await dbQuery(
    `UPDATE commerce_order_items
        SET source_status = 'fulfilled',
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
              'tracking_number', $3::text,
              'tracking_url', $4::text,
              'carrier', $5::text,
              'fulfilled_at', NOW()::text
            ))
      WHERE order_id = $1 AND metadata->>'seller_id' = $2 AND source_status <> 'cancelled'`,
    [orderId, sellerId, trackingNumber, trackingUrl, carrier],
  );

  const shipmentMeta = { seller_id: sellerId, tracking_number: trackingNumber, tracking_url: trackingUrl, carrier };
  const supplierOrderRes = await dbQuery<{ id: string }>(
    `INSERT INTO supplier_orders (
       commerce_order_id, supplier, supplier_order_id, status, metadata, submitted_at
     ) VALUES ($1, 'seller', $2, 'shipped', $3::jsonb, now())
     ON CONFLICT (supplier, supplier_order_id) WHERE supplier_order_id IS NOT NULL
     DO UPDATE SET
       status = 'shipped',
       metadata = supplier_orders.metadata || EXCLUDED.metadata,
       submitted_at = COALESCE(supplier_orders.submitted_at, EXCLUDED.submitted_at),
       updated_at = now()
     RETURNING id`,
    [orderId, `${orderId}:${sellerId}`, JSON.stringify(shipmentMeta)],
  );

  await dbQuery(
    `INSERT INTO fulfillment_shipments (
       commerce_order_id, supplier_order_id, tracking_number, tracking_url, status, shipped_at, metadata
     )
     SELECT $1, $2, $3, $4, 'in_transit', now(), $5::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM fulfillment_shipments WHERE commerce_order_id = $1 AND tracking_number = $3
     )`,
    [
      orderId,
      supplierOrderRes.rows[0]?.id ?? null,
      trackingNumber,
      trackingUrl,
      JSON.stringify({ source: "seller", seller_id: sellerId, carrier }),
    ],
  );

  const statusRes = await dbQuery<{ remaining_items: string | number }>(
    `SELECT COUNT(*) FILTER (WHERE source_status NOT IN ('fulfilled', 'cancelled')) AS remaining_items
       FROM commerce_order_items WHERE order_id = $1`,
    [orderId],
  );
  const remainingItems = Number(statusRes.rows[0]?.remaining_items || 0);

  const patch: Record<string, unknown> = {
    fulfillment_status: remainingItems === 0 ? "shipped" : "partially_shipped",
    latest_tracking_number: trackingNumber,
  };
  if (trackingUrl) patch.latest_tracking_url = trackingUrl;
  if (carrier) patch.tracking_carrier = carrier;
  if (remainingItems === 0) {
    patch.tracking_number = trackingNumber;
    if (trackingUrl) patch.tracking_url = trackingUrl;
  }
  Object.assign(patch, input.orderMetaExtra ?? {});

  const trackingEntry = { ...shipmentMeta, added_at: new Date().toISOString() };
  await dbQuery(
    `UPDATE commerce_orders
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              '{tracking_numbers}',
              COALESCE(metadata->'tracking_numbers', '[]'::jsonb) || jsonb_build_array($3::jsonb),
              true
            ),
            status = CASE WHEN $4::int = 0 THEN 'fulfilled' ELSE status END,
            fulfilled_at = CASE WHEN $4::int = 0 THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END
      WHERE id = $1`,
    [orderId, JSON.stringify(patch), JSON.stringify(trackingEntry), remainingItems],
  );

  if (input.customerEmail) {
    try {
      await sendCustomerShippingAlert(input.customerEmail, trackingNumber, { orderId, trackingUrl });
    } catch (err) {
      logger.error({ err, orderId }, "[seller/shipping] tracking email failed");
    }
  }
  return { remainingItems };
}
