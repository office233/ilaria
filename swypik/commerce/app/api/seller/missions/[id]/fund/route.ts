/**
 * POST /api/seller/missions/[id]/fund — PaymentIntent (RON) pentru fondul de
 * premii (premiu × câștigători). Clientul confirmă cu Stripe Payment Element;
 * webhook-ul `payment_intent.succeeded` (kind 'mission_funding') activează misiunea.
 * Răspuns: { clientSecret, amountCents }
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { UUID } from "@/lib/missions/schemas";
import { createFundingIntent } from "@/lib/missions/funding";
import { logger } from "@/lib/logger";
import { shopPaymentsConfigured } from "@/lib/shop/payments-config";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rl = await rateLimit("seller-mission-fund", auth.sellerId, { limit: 10, window: 600 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // Chei Stripe lipsă sau placeholder (decizia owner-ului în prod) → 503 clar, nu 502.
  if (!shopPaymentsConfigured()) {
    return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
  }
  try {
    const res = await createFundingIntent(id, auth.sellerId);
    if (!res.ok) {
      const status = res.code === "not_found" ? 404 : 409;
      return NextResponse.json({ error: res.code }, { status });
    }
    return NextResponse.json({ clientSecret: res.clientSecret, amountCents: res.amountCents });
  } catch (err) {
    logger.error({ err, missionId: id }, "[seller/missions/fund] intent failed");
    const type = (err as { type?: string } | null)?.type ?? "";
    if (type === "StripeAuthenticationError" || type === "StripePermissionError") {
      return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "payment_failed" }, { status: 502 });
  }
}
