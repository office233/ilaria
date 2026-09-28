/**
 * POST /api/admin/applications/[id]/approve
 * Approves a creator application atomically (lib/admin/applications.ts):
 *  - sets creator_applications.status='approved' (+ reviewed_at) — only from
 *    submitted / in_review, otherwise 409 (state race: double click, two admins)
 *  - promotes user to role='creator' (preserving admin/moderator)
 *  - inserts a row in `creators` (legacy table) if email present, ON CONFLICT DO NOTHING/UPDATE
 *  - logs moderation action
 *  - notifies the user in-app + email, in their locale (best-effort)
 * Permission: partners.
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

  const result = await decideCreatorApplication({
    applicationId: id,
    decision: "approve",
    reason: null,
    actorUserId: actor.userId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "application_not_found" ? 404 : 409 }
    );
  }

  await notifyApplicationDecision({ userId: result.userId, decision: "approved" });

  await logAdminAction({
    action: "application.approve",
    targetType: "creator_application",
    targetId: id,
    req,
    actor,
  });

  return NextResponse.json({ ok: true, action: "approve" });
}
