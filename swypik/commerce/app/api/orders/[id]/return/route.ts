/**
 * Customer Return Request API
 * POST /api/orders/[id]/return
 *
 * Allows a customer to request a return for a delivered/fulfilled order.
 * Requires the order_lookup_token for authentication (same as tracking page).
 * Updates order status to 'return_requested', stores the reason, optional
 * evidence photo URLs, and appends an event to return_history (timeline).
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { canRequestReturn } from "@/lib/commerce/order-status";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { isSafeEvidenceUrl } from "@/lib/security/safe-url";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { OrderReturnRequestSchema, parseBody } from "@/lib/validation/schemas";

import { logger } from "@/lib/logger";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled("returns")) return frozenResponse("returns");
  const { id } = await params;

  const rl = await rateLimit("orderReturn", `${getClientIP(req)}:${id}`);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const rawBody = await req.json().catch(() => ({}));
    const parsed = parseBody(OrderReturnRequestSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: "validation_error", issues: parsed.issues }, { status: 400 });
    }
    const { reason, token, evidenceUrls: rawEvidence } = parsed.data;

    const evidenceUrls: string[] = (rawEvidence ?? []).map((u) => u.trim()).filter((u) => u.length > 0).slice(0, 4);
    const unsafe = evidenceUrls.filter((u) => !isSafeEvidenceUrl(u));
    if (unsafe.length > 0) {
      logger.warn({ orderId: id, unsafe }, "[Return Request] rejected_unsafe_evidence_urls");
      return NextResponse.json(
        { error: "invalid_evidence" },
        { status: 400 }
      );
    }

    const { rows } = await dbQuery(
      `SELECT id, status, metadata
       FROM commerce_orders
       WHERE id = $1::uuid
         AND metadata->>'order_lookup_token' = $2
       LIMIT 1`,
      [id, token]
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "order_not_found" },
        { status: 404 }
      );
    }

    const order = rows[0];
    if (!canRequestReturn({
      status: order.status,
      fulfillmentStatus: order.metadata?.fulfillment_status,
      metadata: order.metadata,
      trackingNumber: order.metadata?.tracking_number,
    })) {
      return NextResponse.json(
        {
          error: "not_returnable",
        },
        { status: 422 }
      );
    }

    if (order.status === "return_requested" || order.metadata?.return_reason) {
      return NextResponse.json(
        { error: "return_already_requested" },
        { status: 409 }
      );
    }

    const event = {
      type: "requested",
      at: new Date().toISOString(),
      reason: reason.trim(),
      evidence_count: evidenceUrls.length,
    };

    await dbQuery(
      `UPDATE commerce_orders
       SET status = 'return_requested',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'return_reason', $1::text,
             'return_requested_at', NOW()::text,
             'return_status', 'requested',
             'return_evidence_urls', $3::jsonb,
             'return_history', COALESCE(metadata->'return_history', '[]'::jsonb) || $4::jsonb
           )
       WHERE id = $2::uuid`,
      [
        reason.trim(),
        order.id,
        JSON.stringify(evidenceUrls),
        JSON.stringify([event]),
      ]
    );

    logger.info({ order_id: order.id, photos_count: evidenceUrls.length }, "[Return Request] received");

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logger.error({ err: error }, "[Return Request Error]");
    return NextResponse.json(
      { error: "internal_error" },
      { status: 500 }
    );
  }
}
