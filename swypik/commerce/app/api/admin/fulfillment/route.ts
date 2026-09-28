/**
 * Admin Fulfillment Actions API
 * POST /api/admin/fulfillment
 * Actions: fulfill, add_tracking, cancel
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { fulfillOrder, updateOrderTracking, cancelOrder } from "@/lib/suppliers/fulfillment";
import { requireAdmin } from "@/lib/admin/guard";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

const BodySchema = z.object({
  action: z.enum(["fulfill", "add_tracking", "cancel"]),
  orderId: z.string().min(1),
  trackingNumber: z.string().min(1).optional(),
  trackingUrl: z.string().url().optional(),
  reason: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  if (!isEnabled("fulfillment")) return frozenResponse("fulfillment");
  try {
    const actor = await requireAdmin(req, "commerce");
    if (actor instanceof NextResponse) return actor;

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "invalid_body" }, { status: 400 });
    }
    const { action, orderId, trackingNumber, trackingUrl, reason } = parsed.data;

    switch (action) {
      case "fulfill": {
        const result = await fulfillOrder(orderId);
        if (result.success) {
          await logAdminAction({
            action: "order.fulfill",
            targetType: "commerce_order",
            targetId: orderId,
            req,
            actor,
          });
        }
        return NextResponse.json(result);
      }

      case "add_tracking": {
        if (!trackingNumber) {
          return NextResponse.json({ success: false, error: "tracking_number_required" }, { status: 400 });
        }
        const ok = await updateOrderTracking(orderId, trackingNumber, trackingUrl);
        if (ok) {
          await logAdminAction({
            action: "order.add_tracking",
            targetType: "commerce_order",
            targetId: orderId,
            details: { trackingNumber },
            req,
            actor,
          });
        }
        return NextResponse.json({ success: ok, orderId });
      }

      case "cancel": {
        const ok = await cancelOrder(orderId, reason);
        if (ok) {
          await logAdminAction({
            action: "order.cancel",
            targetType: "commerce_order",
            targetId: orderId,
            details: { reason: reason ?? null },
            req,
            actor,
          });
        }
        return NextResponse.json({ success: ok, orderId });
      }

      default:
        return NextResponse.json({ success: false, error: "unknown_action" }, { status: 400 });
    }
  } catch (error: unknown) {
    logger.error({ err: error }, "[Admin Fulfillment] Error:");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
