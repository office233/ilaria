/**
 * POST /api/seller/missions/submissions/[id] — jurizare de către sellerul care
 * a finanțat misiunea. Body: { action: 'winner' | 'reject' | 'pay', reason? }
 * 'winner' = câștigător + plata premiului din escrow în portofelul creatorului.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { parseBody } from "@/lib/validation/schemas";
import { judgeActionSchema, UUID } from "@/lib/missions/schemas";
import { judgeErrorStatus, judgeSubmission } from "@/lib/missions/judging";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["seller"]);
  if (auth instanceof NextResponse) return auth;
  if (!auth.sellerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!UUID.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rl = await rateLimit("seller-mission-judge", auth.sellerId, { limit: 60, window: 600 });
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(judgeActionSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "invalid_body", code: parsed.code }, { status: 400 });

  try {
    const res = await judgeSubmission(id, parsed.data, { kind: "seller", sellerId: auth.sellerId });
    if (!res.ok) return NextResponse.json({ error: res.code }, { status: judgeErrorStatus(res.code) });
    return NextResponse.json(res);
  } catch (err) {
    logger.error({ err, submissionId: id }, "[seller/missions/judge] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
