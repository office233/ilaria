/**
 * Datele etichetei de expediere (AWB) pentru partea unui seller dintr-o comandă:
 * folosite de modalul din panou (JSON) și de PDF-ul generat pe server.
 *
 * Numărul AWB e cel al curierului (introdus de seller). Dacă lipsește, eticheta
 * NU inventează unul: PDF-ul tipărește un cod intern al comenzii, marcat clar
 * ca „nu e AWB de curier”.
 */
import { dbQuery } from "@/lib/db";
import { sellerFiscalProfileFromRow, type SellerRow } from "./fiscal-profile";

type AwbDetails = {
  awb_number?: string;
  carrier?: string;
  courier_code?: string;
  tracking_url?: string;
  parcels_count?: number;
  weight_kg?: number;
  notes?: string;
  locker_name?: string;
  generated_at?: string;
};

type ShippingAddress = {
  name?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
};

type OrderMeta = {
  awb_details?: AwbDetails | null;
  tracking_number?: string;
  latest_tracking_number?: string;
  tracking_url?: string;
  latest_tracking_url?: string;
  tracking_carrier?: string;
  shipping_method?: string;
  courier?: string;
  easybox_locker?: string;
  shipping_address?: ShippingAddress;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
};

type OrderItemRow = {
  item_id: string;
  title: string;
  quantity: number;
  unit_amount_cents: number;
  metadata: { tracking_number?: string } | null;
  source_status: string | null;
};

export type AwbLabel = Awaited<ReturnType<typeof buildLabel>>;

/** Codul intern al comenzii (nu e AWB de curier). */
export function internalOrderCode(orderId: string): string {
  return `SWY-${orderId.slice(0, 8).toUpperCase()}`;
}

function buildLabel(
  order: {
    order_id: string;
    order_status: string;
    order_meta: OrderMeta | null;
    created_at: string;
    fulfilled_at: string | null;
    total_cents: number | string;
    currency: string | null;
    items: OrderItemRow[] | null;
  },
  seller: SellerRow | null,
) {
  const meta: OrderMeta = order.order_meta || {};
  const items: OrderItemRow[] = order.items || [];
  const awbDetails = meta.awb_details || null;
  const totalCents = Number(order.total_cents) || 0;
  const trackingNumber =
    awbDetails?.awb_number ||
    meta.tracking_number ||
    meta.latest_tracking_number ||
    items.find((i) => i.metadata?.tracking_number)?.metadata?.tracking_number ||
    null;
  const fiscal = sellerFiscalProfileFromRow(seller);

  return {
    order: {
      id: order.order_id,
      orderNumber: internalOrderCode(order.order_id),
      status: order.order_status,
      createdAt: order.created_at,
      fulfilledAt: order.fulfilled_at,
      currency: (order.currency || "RON").toUpperCase(),
      totalCents,
      totalRon: (totalCents / 100).toFixed(2),
      items: items.map((i) => ({
        id: i.item_id,
        title: i.title,
        quantity: i.quantity,
        unitCents: i.unit_amount_cents,
        unitPriceRon: (i.unit_amount_cents / 100).toFixed(2),
        totalPriceRon: ((i.quantity * i.unit_amount_cents) / 100).toFixed(2),
      })),
    },
    awb: {
      trackingNumber,
      /** Numele curierului sau null (UI-ul afișează textul tradus pentru „fără curier”). */
      carrierName: awbDetails?.carrier || meta.tracking_carrier || meta.shipping_method || meta.courier || null,
      courierCode: awbDetails?.courier_code || null,
      trackingUrl: awbDetails?.tracking_url || meta.tracking_url || meta.latest_tracking_url || null,
      parcelsCount: awbDetails?.parcels_count || 1,
      weightKg: awbDetails?.weight_kg ?? null,
      notes: awbDetails?.notes || "",
      generatedAt: awbDetails?.generated_at || order.fulfilled_at || order.created_at,
    },
    // Câmpurile lipsă rămân goale — nu se completează cu date fictive.
    sender: {
      name: fiscal.legalName,
      cui: fiscal.cui,
      phone: fiscal.phone ?? "",
      email: fiscal.email ?? "",
      address: fiscal.address.street,
      city: fiscal.address.city,
      county: fiscal.address.county,
    },
    recipient: {
      name: meta.shipping_address?.name || meta.customer_name || "",
      phone: meta.customer_phone || meta.shipping_address?.phone || "",
      email: meta.customer_email || "",
      line1: meta.shipping_address?.line1 || "",
      line2: meta.shipping_address?.line2 || "",
      city: meta.shipping_address?.city || "",
      county: meta.shipping_address?.state || "",
      postalCode: meta.shipping_address?.postal_code || "",
      country: meta.shipping_address?.country || "",
      lockerName: awbDetails?.locker_name || meta.easybox_locker || null,
    },
  };
}

export async function loadAwbLabel(sellerId: string, orderId: string) {
  const { rows: orderRows } = await dbQuery<Parameters<typeof buildLabel>[0]>(
    `SELECT
       co.id as order_id,
       co.status as order_status,
       co.metadata as order_meta,
       co.created_at,
       co.fulfilled_at,
       co.currency,
       COALESCE(SUM(coi.quantity * coi.unit_amount_cents) FILTER (WHERE coi.metadata->>'seller_id' = $2), 0) as total_cents,
       json_agg(
         json_build_object(
           'item_id', coi.id,
           'title', coi.title,
           'quantity', coi.quantity,
           'unit_amount_cents', coi.unit_amount_cents,
           'metadata', coi.metadata,
           'source_status', coi.source_status
         )
         ORDER BY coi.created_at
       ) FILTER (WHERE coi.metadata->>'seller_id' = $2) as items
     FROM commerce_orders co
     JOIN commerce_order_items coi ON co.id = coi.order_id
     WHERE co.id = $1 AND coi.metadata->>'seller_id' = $2
     GROUP BY co.id, co.status, co.metadata, co.created_at, co.fulfilled_at, co.currency`,
    [orderId, sellerId],
  );
  if (orderRows.length === 0) return null;

  const { rows: sellerRows } = await dbQuery<SellerRow>(
    `SELECT name, email, phone, cui, business_details FROM sellers WHERE id = $1 LIMIT 1`,
    [sellerId],
  );
  return buildLabel(orderRows[0], sellerRows[0] ?? null);
}
