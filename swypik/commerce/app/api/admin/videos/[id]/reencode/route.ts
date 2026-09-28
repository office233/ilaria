import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam } from "@/lib/validation/params";
import {
  enqueueVideoPipeline,
  findExternalSourceUrlForVideo,
} from "@/lib/video/pipeline";

import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { reprocessVideo } from "@/lib/video/upload/reprocess";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/videos/[id]/reencode
 *
 * Re-process an EXISTING video by pulling its source from an external URL
 * (de regulă .mp4-ul extern la care mai pointează `videos.playback_url`)
 * through the hybrid pipeline:
 *   download → FFmpeg → HLS → R2 → UPDATE videos.playback_url / thumbnail_url.
 *
 * Source URL resolution order (see lib/video/ae-pipeline.ts):
 *   1. body.sourceUrl (manual override)
 *   2. videos.metadata.source_url
 *   3. videos.playback_url if it looks AE-hosted
 *   (sursa externă se ia din metadata.source_url sau playback_url)
 *   5. videos.playback_url (any https)
 *
 * Response: 202 { jobId, sessionId, videoId, queued, queueBackend }.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireAdmin(req, "content");
  if (actor instanceof NextResponse) return actor;

  const { id: videoId } = await params;
  if (!videoId) {
    return NextResponse.json({ error: "missing_video_id" }, { status: 400 });
  }
  if (!isUuidParam(videoId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { sourceUrl?: string; source_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — we'll auto-discover the source URL.
  }

  try {
    const { rows } = await dbQuery<{ id: string; title: string | null }>(
      `SELECT id, title FROM videos WHERE id = $1 AND COALESCE(status, '') <> 'deleted' LIMIT 1`,
      [videoId]
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "video_not_found" }, { status: 404 });
    }

    // 1) Sursa urcată de creator e în bucket → re-transcodare directă (fără URL extern).
    const hasBody = Boolean(body?.sourceUrl || body?.source_url);
    if (!hasBody) {
      try {
        const bucket = await reprocessVideo(videoId, { reencode: true });
        await logAdminAction({
          action: "video.reencode",
          targetType: "video",
          targetId: videoId,
          details: { jobId: bucket.jobId, source: "bucket" },
          req,
          actor,
        });
        return NextResponse.json({ jobId: bucket.jobId, videoId, source: "bucket", queued: true }, { status: 202 });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== "not_found" && code !== "source_missing") throw err;
      }
    }

    // 2) Clipuri importate: sursa externă (metadata.source_url / playback_url mp4).
    const sourceUrl: string | null =
      (typeof body?.sourceUrl === "string" && body.sourceUrl) ||
      (typeof body?.source_url === "string" && body.source_url) ||
      (await findExternalSourceUrlForVideo(videoId));

    if (!sourceUrl) {
      return NextResponse.json(
        { error: "no_source_url" },
        { status: 422 }
      );
    }

    const result = await enqueueVideoPipeline({
      sourceUrl,
      existingVideoId: videoId,
      title: rows[0].title || undefined,
      metadata: { reencode_requested_at: new Date().toISOString() },
    });

    await logAdminAction({
      action: "video.reencode",
      targetType: "video",
      targetId: videoId,
      details: { sourceUrl },
      req,
      actor,
    });

    return NextResponse.json(
      {
        success: true,
        videoId,
        jobId: result.jobId,
        sessionId: result.sessionId,
        assetId: result.assetId,
        sourceUrl,
        queued: result.queued,
        queueBackend: result.queueBackend,
        queueError: result.queueError,
      },
      { status: 202 }
    );
  } catch (error) {
    logger.error({ err: error }, `[Admin Videos] reencode ${videoId} error:`);
    return NextResponse.json(
      { error: "reencode_failed" },
      { status: 500 }
    );
  }
}
