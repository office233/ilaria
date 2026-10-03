/**
 * Seller Refund API
 * POST /api/seller/orders/[id]/refund
 *
 * Allows a seller to approve a return request and execute a full Stripe refund
 * only when that seller owns every item in the order. Multi-seller refunds are
 * blocked for admin handling because Stripe PaymentIntent refunds are order-wide.
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { applySellerRefund, createSellerStripeRefund } from "@/lib/seller/order-refund";
import { evaluateSellerRefundRequest } from "@/lib/seller/refund-policy";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

function statusForPolicyCode(code: string): number {
  switch (code) {
    case "order_not_owned":
      return 404;
    case "invalid_status":
      return 422;
    case "multi_seller_requires_admin":
    case "missing_payment_intent":
      return 409;
    default:
      return 400;
  }
}

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

    const rl = await rateLimit("sellerRefund", sellerId);
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const orderId = id;
    const { rows: orderRows } = await dbQuery(
      `SELECT
         co.id,
         co.status,
         co.metadata,
         COUNT(coi.id)::int AS total_items,
         COUNT(coi.id) FILTER (WHERE coi.metadata->>'seller_id' = $2)::int AS seller_items
       FROM commerce_orders co
       JOIN commerce_order_items coi ON co.id = coi.order_id
       WHERE co.id = $1::uuid
       GROUP BY co.id, co.status, co.metadata
       LIMIT 1`,
      [orderId, sellerId]
    );

    if (orderRows.length === 0 || Number(orderRows[0].seller_items || 0) < 1) {
      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 }
      );
    }

    const order = orderRows[0];
    const paymentIntentId = order.metadata?.stripe_payment_intent;
    const existingRefundId = order.metadata?.refund_id || null;
    const policy = evaluateSellerRefundRequest({
      orderStatus: order.status,
      totalItems: Number(order.total_items || 0),
      sellerItems: Number(order.seller_items || 0),
      paymentIntentId,
      existingRefundId,
    });

    if (!policy.allowed) {
      if (policy.code === "already_refunded") {
        return NextResponse.json({ success: true, alreadyRefunded: true, refundId: existingRefundId });
      }

      return NextResponse.json(
        { success: false, error: policy.code, message: policy.message },
        { status: statusForPolicyCode(policy.code) }
      );
    }

    const refund = await createSellerStripeRefund({ orderId, sellerId, paymentIntentId, amountCents: null, mode: "return" });
    if (!refund.ok) {
      return NextResponse.json({ success: false, error: "stripe_refund_failed", code: refund.code }, { status: 502 });
    }
    // Banii au plecat de la Stripe: consecințele în DB sunt atomice (lib/seller/order-refund).
    await applySellerRefund({ orderId, sellerId, paymentIntentId, mode: "return", refund });
    const refundId = refund.refundId;
    const refundStatus = refund.status;

    logger.info({ order_id: orderId, seller_id: sellerId }, "[Seller Refund] order marked as refunded");

    return NextResponse.json({ success: true, refundId, refundStatus });
  } catch (error) {
    logger.error({ err: error }, "[Seller Refund] Unexpected error:");
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 }
    );
  }
}
