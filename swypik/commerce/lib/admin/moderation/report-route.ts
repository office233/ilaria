/**
 * Handler comun pentru POST /api/admin/moderation/[id]/{dismiss,hide-video,delete-video,ban-creator}:
 * permisiune `moderation`, id validat, notă opțională (zod), decizie tranzacțională,
 * audit cu actorul numit.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { applyReportAction, type ReportAction } from "./report-actions";

const Body = z.object({ note: z.string().trim().max(500).optional() }).passthrough();

const AUDIT_ACTION: Record<ReportAction, string> = {
  dismiss: "moderation.dismiss",
  hide_video: "moderation.hide_video",
  delete_video: "moderation.delete_video",
  ban_creator: "moderation.ban_creator",
};

export function reportActionRoute(action: ReportAction) {
  return async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const actor = await requireAdmin(req, "moderation");
    if (actor instanceof NextResponse) return actor;

    const { id } = await params;
    if (!isUuidParam(id)) return invalidIdResponse();

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    const note = parsed.data.note || null;

    const result = await applyReportAction({ reportId: id, action, note, actorUserId: actor.userId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    const r = result.report;
    const onUser = action === "ban_creator";
    await logAdminAction({
      action: AUDIT_ACTION[action],
      targetType: onUser ? "user" : action === "dismiss" ? "moderation_report" : "video",
      targetId: onUser ? r.creator_id : action === "dismiss" ? r.id : r.target_video_id,
      details: { reportId: r.id, videoId: r.target_video_id, creatorId: r.creator_id, reason: r.reason, note },
      actor,
      req,
    });
    return NextResponse.json({ ok: true, action });
  };
}
