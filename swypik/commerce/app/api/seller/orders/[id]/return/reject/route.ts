/**
 * Seller — reject return request
 * POST /api/seller/orders/[id]/return/reject
 *
 * Marks an existing return request as rejected. Requires the seller to own
 * at least one item in the order. Does not refund. Appends rejection event
 * to metadata.return_history and resets order status back to its previous
 * fulfillment state ('delivered' if a delivery date is recorded, otherwise
 * 'fulfilled') so the customer can re-open or move on.
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled("returns")) return frozenResponse("returns");
  const { id } = await params;
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) {
      return NextResponse.json(
        { success: false, error: "unauthorized" },
        { status: 401 }
      );
    }

    const rl = await rateLimit("sellerReturns", sellerId);
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const note: string | null =
      typeof body?.note === "string" && body.note.trim().length > 0
        ? body.note.trim().slice(0, 500)
        : null;

    const { rows } = await dbQuery(
      `SELECT
         co.id,
         co.status,
         co.metadata,
         COUNT(coi.id) FILTER (WHERE coi.metadata->>'seller_id' = $2)::int AS seller_items
       FROM commerce_orders co
       JOIN commerce_order_items coi ON co.id = coi.order_id
       WHERE co.id = $1::uuid
       GROUP BY co.id, co.status, co.metadata
       LIMIT 1`,
      [id, sellerId]
    );

    if (rows.length === 0 || Number(rows[0].seller_items || 0) < 1) {
      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 }
      );
    }

    const order = rows[0];
    if (order.status !== "return_requested" && order.metadata?.return_status !== "requested") {
      return NextResponse.json(
        { success: false, error: "invalid_status" },
        { status: 422 }
      );
    }

    const previousStatus =
      order.metadata?.delivered_at ? "delivered" :
      order.metadata?.fulfillment_status === "fulfilled" || order.metadata?.tracking_number
        ? "fulfilled"
        : "paid";

    const event = {
      type: "rejected",
      at: new Date().toISOString(),
      by: `seller:${sellerId}`,
      note: note || "Cerere respinsă de vânzător",
    };

    await dbQuery(
      `UPDATE commerce_orders
       SET status = $2::text,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'return_status', 'rejected',
             'return_rejected_at', NOW()::text,
             'return_rejected_by', $3::text,
             'return_history', COALESCE(metadata->'return_history', '[]'::jsonb) || $4::jsonb
           )
       WHERE id = $1::uuid`,
      [id, previousStatus, sellerId, JSON.stringify([event])]
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[Seller Return Reject] failed");
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 }
    );
  }
}
