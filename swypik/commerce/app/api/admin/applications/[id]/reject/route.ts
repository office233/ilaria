/**
 * POST /api/admin/applications/[id]/reject
 * Rejects a creator application atomically with a required reason
 * (lib/admin/applications.ts) — only from submitted / in_review, otherwise 409.
 * Stores reason in review_note + metadata.reject_reason.
 * Sends notification email best-effort. Permission: partners.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { decideCreatorApplication } from "@/lib/admin/applications";
import { notifyApplicationDecision } from "@/lib/creator/application-notify";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireAdmin(req, "partners");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const reason =
    typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) {
    return NextResponse.json(
      { error: "reason_required" },
      { status: 400 }
    );
  }

  const result = await decideCreatorApplication({
    applicationId: id,
    decision: "reject",
    reason,
    actorUserId: actor.userId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "application_not_found" ? 404 : 409 }
    );
  }

  await notifyApplicationDecision({ userId: result.userId, decision: "rejected", reason });

  await logAdminAction({
    action: "application.reject",
    targetType: "creator_application",
    targetId: id,
    details: { reason },
    req,
    actor,
  });

  return NextResponse.json({ ok: true, action: "reject" });
}
