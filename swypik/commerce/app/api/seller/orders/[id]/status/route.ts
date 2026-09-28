/**
 * POST /api/seller/orders/[id]/status  { action: 'accept' | 'deliver' | 'cancel' }
 *
 * Tranzițiile comenzii din partea seller-ului (lib/seller/fulfilment.ts).
 * Expedierea (cu AWB) are ruta ei: POST /api/seller/orders/[id]/awb.
 * `cancel` rambursează prin Stripe item-urile seller-ului și le repune pe stoc.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";
import { runSellerOrderAction } from "@/lib/seller/order-actions";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ action: z.enum(["accept", "deliver", "cancel"]) }).strict();

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  invalid_transition: 409,
  missing_payment_intent: 409,
  stripe_refund_failed: 502,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const parsed = parseBody(BodySchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });

  const bucket = parsed.data.action === "cancel" ? "sellerRefund" : "sellerOrders";
  const rl = await rateLimit(bucket, sellerId);
  if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

  try {
    const res = await runSellerOrderAction(sellerId, id, parsed.data.action);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: res.code, ...(res.stripeCode ? { code: res.stripeCode } : {}) },
        { status: STATUS_BY_CODE[res.code] ?? 400 },
      );
    }
    return NextResponse.json({ success: true, state: res.state, refundId: res.refundId ?? null });
  } catch (err) {
    logger.error({ err, orderId: id }, "[seller/orders/status] failed");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
