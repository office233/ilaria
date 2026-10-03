/**
 * POST /api/admin/moderation/videos/[id] — body { decision: "approve" | "reject", reason? }
 * Coada „în așteptare” + „semnalate” din /admin/moderation. Permisiune: moderation.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { afterVideoDecision, decideVideo } from "@/lib/admin/moderation/video-decision";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(500).optional(),
  })
  // Respingerea cere un motiv (creatorul îl vede în dashboard).
  .refine((b) => b.decision === "approve" || Boolean(b.reason), { message: "reason_required" });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "moderation");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const reasonMissing = parsed.error.issues.some((i) => i.message === "reason_required");
    return NextResponse.json({ error: reasonMissing ? "reason_required" : "invalid_body" }, { status: 400 });
  }
  const { decision } = parsed.data;
  const reason = parsed.data.reason || null;

  const result = await decideVideo({ videoId: id, decision, reason, actorUserId: actor.userId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
  }

  await logAdminAction({
    action: `video.moderation_${decision}`,
    targetType: "video",
    targetId: id,
    details: { reason, creatorId: result.creatorId, published: result.published, casesClosed: result.casesClosed },
    actor,
    req,
  });
  await afterVideoDecision(result, decision);

  return NextResponse.json({ ok: true, decision, published: result.published });
}
