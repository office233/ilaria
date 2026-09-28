/**
 * Order Lookup API
 * GET /api/orders/[id]
 * Public/customer tracking uses order_lookup_token as the path segment.
 * Admin requests may still load by internal order UUID via the admin cookie.
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { deriveOrderStatus } from "@/lib/commerce/order-status";
import { isEnabled } from "@/lib/feature-flags";
import { isAdminRequest } from "@/lib/security/admin-auth";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // Anti brute-force on lookup tokens: 30 lookups/min per IP
    const ip = getClientIP(req);
    const { success: allowed } = await rateLimit("order-lookup", ip, { limit: 30, window: 60 });
    if (!allowed) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const isAdmin = await isAdminRequest(req);
    const looksLikeUuid = UUID_RE.test(id);
    const lookupValue = token || id;

    const { rows } = await dbQuery(
      `SELECT
         id,
         status,
         (total_cents::numeric / 100) AS total_ron,
         metadata,
         created_at,
         fulfilled_at
       FROM commerce_orders
       WHERE
         metadata->>'order_lookup_token' = $1
         OR ($2::boolean AND id = $3::uuid)
       LIMIT 1`,
      [lookupValue, isAdmin && looksLikeUuid, looksLikeUuid ? id : null]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }

    const order = rows[0];
    const meta = order.metadata || {};
    if (!isAdmin && lookupValue !== meta.order_lookup_token) {
      return NextResponse.json({ error: "invalid_link" }, { status: 403 });
    }

    const { rows: items } = await dbQuery(
      `SELECT title, quantity, (unit_amount_cents::numeric / 100) AS unit_price
       FROM commerce_order_items WHERE order_id = $1`,
      [order.id]
    );

    const trackingNumbers = Array.isArray(meta.tracking_numbers) ? meta.tracking_numbers : [];
    const latestTracking = trackingNumbers.length > 0 ? trackingNumbers[trackingNumbers.length - 1] : null;
    const trackingNumber = meta.tracking_number || meta.latest_tracking_number || latestTracking?.tracking_number || null;
    const trackingUrl = meta.tracking_url || meta.latest_tracking_url || latestTracking?.tracking_url || null;
    const fulfillmentStatus = meta.fulfillment_status || "pending";
    const derivedStatus = deriveOrderStatus({
      status: order.status,
      fulfillmentStatus,
      metadata: meta,
      trackingNumber,
    });

    return NextResponse.json({
      id: order.id,
      status: order.status,
      paymentStatus: order.status,
      fulfillmentStatus,
      displayStatus: derivedStatus.key,
      statusLabel: derivedStatus.label,
      statusDetail: derivedStatus.description,
      statusStep: derivedStatus.step,
      isTerminal: derivedStatus.isTerminal,
      isReturnable: derivedStatus.isReturnable,
      // Butonul de retur apare doar cu FEATURE_RETURNS pornit (altfel POST-ul dă 410).
      returnsEnabled: isEnabled("returns"),
      totalRon: Number(order.total_ron),
      items,
      shipping: meta.shipping_address || null,
      trackingNumber,
      trackingUrl,
      trackingNumbers,
      returnReason: meta.return_reason || null,
      returnRequestedAt: meta.return_requested_at || null,
      createdAt: order.created_at,
      fulfilledAt: order.fulfilled_at,
    });
  } catch (error: unknown) {
    logger.error({ err: error }, "[Order Lookup]");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
