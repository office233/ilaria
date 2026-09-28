/**
 * POST /api/local-orders/[id]/pay  { action: "confirm" }
 *
 * După confirmPayment (Stripe Payment Element) clientul cere serverului să
 * verifice hold-ul la Stripe (capture_method=manual): comanda devine vizibilă
 * restaurantului, care primește push-ul „comandă nouă"; încasarea are loc la
 * acceptare (audit food-go #7). Acces: clientul logat sau token-ul guest.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { guestTokenFromRequest, guestTokenMatches } from "@/lib/food/guest-token";
import { syncLocalOrderAuthorization } from "@/lib/food/card-payment";
import { notifyMerchantNewOrder } from "@/lib/food/merchant-notify";
import { maybeAutoDispatch } from "@/lib/dispatch/auto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ action: z.literal("confirm") });
const PAY_LIMIT = { limit: 20, window: 60 };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  const rl = await rateLimit("foodPay", session?.userId ?? getClientIP(req), PAY_LIMIT);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (!BodySchema.safeParse(await req.json().catch(() => null)).success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const { rows } = await dbQuery<{ customer_user_id: string | null; guest_token_hash: string | null }>(
    `SELECT customer_user_id, guest_token_hash FROM local_orders WHERE id = $1`,
    [id],
  );
  const o = rows[0];
  const allowed =
    !!o &&
    ((!!session?.userId && o.customer_user_id === session.userId) ||
      guestTokenMatches(guestTokenFromRequest(req), o.guest_token_hash));
  if (!allowed) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const state = await syncLocalOrderAuthorization(id);
  if (state === "authorized" || state === "paid") {
    await notifyMerchantNewOrder(id);
    await maybeAutoDispatch(id, "placed");
  }
  const http = state === "card_unavailable" ? 503 : 200;
  return NextResponse.json({ payment: state }, { status: http });
}
