import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { recordSellerShipment } from "@/lib/seller/shipping";
import { logger } from "@/lib/logger";
import { SellerGenerateAwbSchema, parseBody } from "@/lib/validation/schemas";
import { carrierName, carrierTrackingUrl, type CarrierCode } from "@/lib/fulfillment/carriers";
import { loadAwbLabel } from "@/lib/seller/awb-label";

export const dynamic = "force-dynamic";

// Neplătite sau închise: nu se pot expedia (vezi lib/seller/fulfilment.ts).
const SHIP_BLOCKED_STATUSES = new Set(["pending", "authorized", "cancelled", "refunded", "failed", "return_requested"]);

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

/** Subsetul din commerce_orders.metadata citit/scris de această rută. */
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

/**
 * Numărul AWB vine de la curier (introdus de seller). Nu se „generează" local:
 * versiunea anterioară fabrica numere cu Math.random() și le trimitea clienților.
 */
function resolveAwb(courier: CarrierCode, manualNumber?: string) {
  const awb = manualNumber?.trim();
  if (!awb) return null;
  return { trackingNumber: awb, carrierName: carrierName(courier), trackingUrl: carrierTrackingUrl(courier, awb) };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const { id: orderId } = await params;

    const label = await loadAwbLabel(sellerId, orderId);
    if (!label) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...label });
  } catch (error) {
    logger.error({ err: error }, "[Seller AWB API] GET Error:");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("sellerAwb", sellerId);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const { id: orderId } = await params;
    const rawBody = await req.json().catch(() => ({}));
    const parsed = parseBody(SellerGenerateAwbSchema, rawBody);
    if (!parsed.ok) {
      logger.warn({ issues: parsed.issues }, "[Seller AWB API] validation_error");
      return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
    }

    const { courier, parcels_count, weight_kg, manual_tracking_number, notes, locker_name } = parsed.data;

    // Check that order exists and seller owns items in it
    const checkOrder = await dbQuery<{ status: string; metadata: OrderMeta | null }>(
      `SELECT co.status, co.metadata
       FROM commerce_orders co
       JOIN commerce_order_items coi ON co.id = coi.order_id
       WHERE co.id = $1 AND coi.metadata->>'seller_id' = $2
       LIMIT 1`,
      [orderId, sellerId]
    );

    if (checkOrder.rows.length === 0) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 403 });
    }

    const currentStatus = checkOrder.rows[0].status;
    if (SHIP_BLOCKED_STATUSES.has(currentStatus)) {
      return NextResponse.json(
        { success: false, error: "invalid_status" },
        { status: 409 }
      );
    }

    const resolved = resolveAwb(courier, manual_tracking_number);
    if (!resolved) {
      return NextResponse.json(
        { success: false, error: "awb_number_required" },
        { status: 422 },
      );
    }
    const { trackingNumber, carrierName: resolvedCarrierName, trackingUrl } = resolved;

    const awbDetailsObj = {
      awb_number: trackingNumber,
      carrier: resolvedCarrierName,
      courier_code: courier,
      parcels_count,
      weight_kg,
      notes: notes || null,
      locker_name: locker_name || null,
      generated_at: new Date().toISOString(),
    };
    const orderMetaExtra: Record<string, unknown> = {
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      shipping_method: resolvedCarrierName,
      awb_details: awbDetailsObj,
    };
    if (locker_name) orderMetaExtra.easybox_locker = locker_name;

    await recordSellerShipment({
      orderId,
      sellerId,
      trackingNumber,
      trackingUrl,
      carrier: resolvedCarrierName,
      customerEmail: checkOrder.rows[0].metadata?.customer_email ?? null,
      orderMetaExtra,
    });

    return NextResponse.json({
      success: true,
      awb: {
        awbNumber: trackingNumber,
        carrier: resolvedCarrierName,
        courierCode: courier,
        trackingUrl,
        parcelsCount: parcels_count,
        weightKg: weight_kg,
        generatedAt: awbDetailsObj.generated_at,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "[Seller AWB API] POST Error:");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
