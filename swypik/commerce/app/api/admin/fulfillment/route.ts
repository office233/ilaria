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

const OrderIdSchema = z.string().uuid("orderId invalid");
const TrackingUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => /^https:\/\//i.test(value), "trackingUrl must use https");

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("fulfill"),
    orderId: OrderIdSchema,
  }).strict(),
  z.object({
    action: z.literal("add_tracking"),
    orderId: OrderIdSchema,
    trackingNumber: z.string().trim().min(1).max(120),
    trackingUrl: TrackingUrlSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    orderId: OrderIdSchema,
    reason: z.string().trim().max(500).optional(),
  }).strict(),
]);

export async function POST(req: Request) {
  if (!isEnabled("fulfillment")) return frozenResponse("fulfillment");
  try {
    const actor = await requireAdmin(req, "commerce");
    if (actor instanceof NextResponse) return actor;

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "invalid_body" }, { status: 400 });
    }
    const body = parsed.data;
    const { action, orderId } = body;

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
        const ok = await updateOrderTracking(orderId, body.trackingNumber, body.trackingUrl);
        if (ok) {
          await logAdminAction({
            action: "order.add_tracking",
            targetType: "commerce_order",
            targetId: orderId,
            details: { trackingNumber: body.trackingNumber },
            req,
            actor,
          });
        }
        return NextResponse.json({ success: ok, orderId });
      }

      case "cancel": {
        const ok = await cancelOrder(orderId, body.reason);
        if (ok) {
          await logAdminAction({
            action: "order.cancel",
            targetType: "commerce_order",
            targetId: orderId,
            details: { reason: body.reason ?? null },
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
