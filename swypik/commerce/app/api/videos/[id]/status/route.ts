/**
 * GET /api/videos/[id]/status
 *
 * Public: doar clipurile vizibile (ready + public/unlisted + safe) și doar
 * câmpurile de redare. Autorul/adminul vede și draft-urile, procesarea și eroarea.
 * (Înainte expunea fără autentificare statusul și URL-urile oricărui draft.)
 * Wizardul de upload folosește /api/creator/upload-session/[id] pentru progres.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getCreatorUserId, getUserRole } from "@/lib/creator/session";
import { isUuid } from "@/lib/video/upload-session";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  creator_id: string;
  status: string;
  visibility: string;
  is_hidden: boolean;
  effective_label: string;
  moderation_status: string;
  playback_url: string | null;
  thumbnail_url: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  job_status: string | null;
  job_stage: string | null;
  job_progress: number | null;
  job_error_code: string | null;
};

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400, headers: NO_STORE });

  const { rows } = await dbQuery<Row>(
    `SELECT v.id, v.creator_id, v.status, v.visibility, v.is_hidden, v.effective_label, v.moderation_status,
            v.playback_url, v.thumbnail_url, v.duration_ms, v.width, v.height,
            j.status AS job_status, j.stage AS job_stage, j.progress AS job_progress, j.error_code AS job_error_code
       FROM videos v
       LEFT JOIN LATERAL (
         SELECT status, stage, progress, error_code FROM video_processing_jobs
          WHERE video_id = v.id ORDER BY created_at DESC LIMIT 1
       ) j ON true
      WHERE v.id = $1 AND v.status <> 'deleted'
      LIMIT 1`,
    [id],
  );
  const v = rows[0];
  if (!v) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const viewerId = await getCreatorUserId();
  const isOwner = Boolean(viewerId && (viewerId === v.creator_id || (await getUserRole(viewerId)) === "admin"));
  const isVisible =
    v.status === "ready" && ["public", "unlisted"].includes(v.visibility) && !v.is_hidden && v.effective_label === "safe";
  if (!isOwner && !isVisible) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const playback = {
    videoId: v.id,
    status: v.status,
    playbackUrl: v.playback_url,
    thumbnailUrl: v.thumbnail_url,
    durationMs: v.duration_ms,
    width: v.width,
    height: v.height,
  };
  if (!isOwner) return NextResponse.json(playback, { headers: NO_STORE });
  return NextResponse.json(
    {
      ...playback,
      visibility: v.visibility,
      moderationStatus: v.moderation_status,
      jobStatus: v.job_status,
      stage: v.job_stage,
      progress: v.job_progress,
      errorCode: v.job_error_code,
    },
    { headers: NO_STORE },
  );
}
