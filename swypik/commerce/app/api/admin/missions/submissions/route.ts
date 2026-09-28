/**
 * Admin — jurizarea înscrierilor la misiuni (orice misiune, seller sau platformă).
 *  POST /api/admin/missions/submissions { submissionId, action: 'winner'|'reject'|'pay', reason? }
 *    - winner: câștigător + plata premiului din escrow în portofelul RON (atomic)
 *    - pay:    reîncearcă plata unui câștigător rămas neplătit (rânduri vechi)
 *    - reject: respinsă
 *  Lista înscrierilor unei misiuni: GET /api/admin/missions/[id].
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/getAuthUser";
import { parseBody } from "@/lib/validation/schemas";
import { judgeActionSchema, UUID } from "@/lib/missions/schemas";
import { judgeErrorStatus, judgeSubmission } from "@/lib/missions/judging";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const BodySchema = judgeActionSchema.extend({ submissionId: UUID });

export async function POST(req: Request) {
  const auth = await requireAuth(req, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = parseBody(BodySchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: "invalid_params", code: parsed.code }, { status: 400 });
  const { submissionId, ...action } = parsed.data;

  try {
    const res = await judgeSubmission(submissionId, action, { kind: "admin", label: auth.userId ?? "token" });
    if (!res.ok) return NextResponse.json({ error: res.code }, { status: judgeErrorStatus(res.code) });
    await logAdminAction({
      action: `mission_submission.${action.action}`,
      targetType: "mission_submission",
      targetId: submissionId,
      details: { prizeCents: res.prizeCents ?? null, reason: action.reason ?? null },
      req,
    });
    return NextResponse.json(res);
  } catch (err) {
    logger.error({ err, submissionId }, "[admin/missions/submissions] judge failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
