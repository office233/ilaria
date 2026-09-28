/**
 * POST /api/local-orders/[id]/cancel  { reason? }
 *
 * Clientul își anulează comanda cât timp restaurantul nu a confirmat-o
 * (status 'placed'). Acces: clientul logat al comenzii sau token-ul guest
 * (header x-order-token / ?t=). Plata cu cardul se rambursează / PaymentIntent-ul
 * se anulează automat (lib/food/refund.ts).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { FOOD_RATE_LIMITS } from "@/lib/food/config";
import { guestTokenFromRequest, guestTokenMatches } from "@/lib/food/guest-token";
import { transitionOrder } from "@/lib/food/transition";
import { runTransitionEffects } from "@/lib/food/transition-effects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
    }
    const session = await getAuthSession();
    const userId = session?.userId ?? null;
    const token = guestTokenFromRequest(req);
    if (!userId && !token) {
      return NextResponse.json({ success: false, error: "unauthorized", code: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("foodCancel", userId ?? req.headers.get("cf-connecting-ip") ?? "anon", FOOD_RATE_LIMITS.cancel);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited", code: "rate_limited" }, { status: 429 });
    }

    const parsed = parseBody(CancelSchema, (await req.json().catch(() => null)) ?? {});
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
    }

    const result = await transitionOrder({
      orderId: id,
      to: "cancelled",
      actor: "customer",
      reason: parsed.data.reason ?? null,
      authorize: (o) =>
        (!!userId && o.customer_user_id === userId) || guestTokenMatches(token, o.guest_token_hash),
    });
    if (!result.ok) {
      // Nu dezvăluim existența comenzii cui nu are acces.
      const code = result.code === "forbidden" ? "not_found" : result.code;
      const http = result.code === "forbidden" ? 404 : result.http;
      return NextResponse.json({ success: false, error: code, code }, { status: http });
    }

    const { refund } = await runTransitionEffects({
      orderId: id,
      status: "cancelled",
      customerUserId: result.customerUserId,
      merchantName: result.merchantName,
      reason: parsed.data.reason ?? "customer_cancelled",
      notifyCustomer: false,
    });
    return NextResponse.json({ success: true, order: result.order, refund_status: refund?.status ?? null });
  } catch (error: unknown) {
    logger.error({ err: error }, "[local-orders/cancel] error");
    return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
  }
}
