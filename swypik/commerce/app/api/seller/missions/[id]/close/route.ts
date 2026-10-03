/**
 * POST /api/seller/missions/[id]/close — închide misiunea proprie și
 * returnează pe card restul neplătit din fondul de premii.
 * Răspuns: { ok, refundedCents } · 409 unpaid_winners / already_closed
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { UUID } from "@/lib/missions/schemas";
import { closeMission } from "@/lib/missions/funding";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rl = await rateLimit("seller-mission-close", auth.sellerId, { limit: 10, window: 600 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const res = await closeMission(id, { sellerId: auth.sellerId });
    if (!res.ok) return NextResponse.json({ error: res.code }, { status: res.code === "not_found" ? 404 : 409 });
    return NextResponse.json({ ok: true, refundedCents: res.refundedCents });
  } catch (err) {
    logger.error({ err, missionId: id }, "[seller/missions/close] failed");
    return NextResponse.json({ error: "refund_failed" }, { status: 502 });
  }
}
