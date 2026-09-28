import { NextResponse } from "next/server";
import { autoEmbedVideo } from "@/lib/ai/auto-embed";
import { dbQuery } from "@/lib/db";
import { mediaPublicBaseUrl } from "@/lib/storage/config";

import { requireAdmin } from "@/lib/admin/guard";
import {
  legacyApproveVideoAsset,
  legacyRejectVideoAsset,
  videoAssetIsLive,
  VIDEO_REJECT_DEFAULT_REASON,
} from "@/lib/admin/videos";
import { isUuidParam } from "@/lib/validation/params";
import { notifyVideoApproved, notifyVideoRejected } from "@/lib/email/creator-notifications";
import { enqueueVideoPipeline } from "@/lib/video/pipeline";

import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { notifyLocalized } from "@/lib/notifications/localized";
export const dynamic = "force-dynamic";

/** Email către creatorul asset-ului — doar dacă avem nume + titlu reale. */
function notifyCreatorByEmail(
  assetId: string,
  send: (email: string, name: string, title: string) => Promise<unknown>,
): void {
  dbQuery<{ email: string | null; name: string | null; title: string | null }>(
    `SELECT u.email, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, NULLIF(v.title, '') AS title
       FROM video_assets va
       JOIN videos v ON va.video_id = v.id
       JOIN users u ON v.creator_id = u.id
      WHERE va.id = $1`,
    [assetId]
  )
    .then(({ rows }) => {
      const row = rows[0];
      if (row?.email && row.name && row.title) {
        return send(row.email, row.name, row.title);
      }
      return undefined;
    })
    .catch((err) => logger.warn({ err, assetId }, "[Admin Videos] creator email failed"));
}

/**
 * GET /api/admin/videos — list all video assets for admin review.
 *
 * Schema (migration 0001):
 *   video_assets: video_id, asset_type, object_key, status, duration_ms, width, height
 *   videos:       creator_id, title, description, product_refs, status
 *   video_processing_jobs: video_id, asset_id, status, attempt_count, error_message
 */
export async function GET(req: Request) {
  const actor = await requireAdmin(req, "content");
  if (actor instanceof NextResponse) return actor;

  try {
    const publicUrl = mediaPublicBaseUrl();
    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") || 50);
    const rawOffset = Number(url.searchParams.get("offset") || 0);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
    const statusFilter = (url.searchParams.get("status") || "all").toLowerCase();
    const search = (url.searchParams.get("search") || "").trim();

    // Filter expression compatible with the derived status returned to the client.
    // Status mapping: video_status='ready' OR va.status='available' → 'ready'; otherwise va.status.
    const where: string[] = [`va.asset_type = 'source'`];
    const params: (string | number)[] = [];

    if (statusFilter !== "all") {
      params.push(statusFilter);
      if (statusFilter === "ready") {
        where.push(`(v.status = 'ready' OR va.status = 'available')`);
        params.pop(); // not used as param
      } else if (statusFilter === "failed") {
        where.push(`va.status = 'failed'`);
        params.pop();
      } else if (statusFilter === "processing") {
        where.push(`va.status = 'processing'`);
        params.pop();
      } else if (statusFilter === "pending") {
        where.push(`(va.status = 'pending' OR va.status IS NULL)`);
        params.pop();
      } else {
        where.push(`va.status = $${params.length}`);
      }
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(v.title ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Totals — calculated independently of pagination/filter for global KPI accuracy
    const totalsRes = await dbQuery(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE v.status = 'ready' OR va.status = 'available') AS ready,
         COUNT(*) FILTER (WHERE va.status = 'processing') AS processing,
         COUNT(*) FILTER (WHERE va.status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE va.status = 'pending' OR va.status IS NULL) AS pending
       FROM video_assets va
       JOIN videos v ON va.video_id = v.id
       WHERE va.asset_type = 'source'`
    );
    const totalsRow = totalsRes.rows[0] || {};
    const totals = {
      total: Number(totalsRow.total) || 0,
      ready: Number(totalsRow.ready) || 0,
      processing: Number(totalsRow.processing) || 0,
      failed: Number(totalsRow.failed) || 0,
      pending: Number(totalsRow.pending) || 0,
    };

    // Filtered count (for pagination)
    const filteredCountRes = await dbQuery(
      `SELECT COUNT(*) AS c
         FROM video_assets va
         JOIN videos v ON va.video_id = v.id
         LEFT JOIN users u ON v.creator_id = u.id
         ${whereSql}`,
      params
    );
    const filteredTotal = Number(filteredCountRes.rows[0]?.c) || 0;

    params.push(limit);
    params.push(offset);

    const { rows } = await dbQuery(`
      SELECT 
        va.id,
        va.asset_type,
        va.object_key,
        va.public_url,
        va.status,
        va.duration_ms,
        va.width,
        va.height,
        va.metadata  AS asset_metadata,
        va.created_at,
        v.id          AS video_id,
        v.title       AS video_title,
        v.description AS video_description,
        v.status      AS video_status,
        v.product_refs,
        u.display_name AS creator_name,
        u.email        AS creator_email,
        vpj.status     AS job_status,
        vpj.attempt_count AS job_attempts,
        vpj.error_message AS job_error
      FROM video_assets va
      JOIN videos v ON va.video_id = v.id
      LEFT JOIN users u ON v.creator_id = u.id
      LEFT JOIN LATERAL (
        SELECT status, attempt_count, error_message
        FROM video_processing_jobs 
        WHERE video_id = v.id
        ORDER BY created_at DESC
        LIMIT 1
      ) vpj ON true
      ${whereSql}
      ORDER BY va.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // Derive product info from videos.product_refs JSONB array
    type VideoAssetRow = {
      id: string;
      video_id: string;
      object_key: string | null;
      public_url: string | null;
      status: string;
      duration_ms: number | null;
      width: number | null;
      height: number | null;
      asset_metadata: Record<string, unknown> | null;
      created_at: string;
      video_title: string | null;
      video_description: string | null;
      video_status: string | null;
      product_refs: unknown;
      creator_name: string | null;
      creator_email: string | null;
      job_status: string | null;
      job_attempts: number | null;
      job_error: string | null;
    };
    const videos = (rows as VideoAssetRow[]).map((r) => {
      let productId: string | null = null;
      try {
        const refs = typeof r.product_refs === "string"
          ? JSON.parse(r.product_refs)
          : r.product_refs;
        if (Array.isArray(refs) && refs.length > 0) {
          const firstRef = refs[0];
          productId = typeof firstRef === "string"
            ? firstRef
            : firstRef?.product_id || firstRef?.id || null;
        }
      } catch { /* ignore */ }

      const assetMetadata = (r.asset_metadata || {}) as Record<string, string | undefined>;
      const status = r.video_status === "ready" || r.status === "available" ? "ready" : r.status;

      return {
        id: r.id,
        video_id: r.video_id,
        status,
        video_status: r.video_status,
        raw_key: r.object_key,
        mp4_key: assetMetadata.mp4_key || assetMetadata.preview_key || null,
        thumbnail_key: assetMetadata.thumbnail_key || null,
        thumbnail_url: assetMetadata.thumbnail_url
          || (assetMetadata.thumbnail_key && publicUrl ? `${publicUrl}/${assetMetadata.thumbnail_key}` : null),
        hls_master_key: assetMetadata.master_key || null,
        playback_url: r.public_url,
        object_key: r.object_key,
        duration_seconds: r.duration_ms ? Math.round(r.duration_ms / 1000) : null,
        width: r.width,
        height: r.height,
        title: r.video_title,
        description: r.video_description,
        creator_name: r.creator_name,
        creator_email: r.creator_email,
        product_id: productId,
        error_message: r.job_error,
        job_status: r.job_status,
        job_attempts: r.job_attempts,
        created_at: r.created_at,
      };
    });

    return NextResponse.json({
      videos,
      totals,
      filteredTotal,
      limit,
      offset,
      hasMore: offset + videos.length < filteredTotal,
    });
  } catch (error) {
    logger.error({ err: error }, "[Admin Videos] GET error:");
    return NextResponse.json(
      { error: "fetch_failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const actor = await requireAdmin(req, "content");
  if (actor instanceof NextResponse) return actor;

  try {
    const body = await req.json();
    const { action, videoId, reason } = body;

    if (!action) {
      return NextResponse.json({ error: "missing_action" }, { status: 400 });
    }
    // import_ae / import_url don't operate on an existing videoId; everything else does.
    if (action !== "import_ae" && action !== "import_url" && !videoId) {
      return NextResponse.json(
        { error: "missing_video_id" },
        { status: 400 }
      );
    }
    if (action !== "import_ae" && action !== "import_url" && !isUuidParam(videoId)) {
      return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    }

    switch (action) {
      case "approve": {
        // Aprobarea asset-ului sursă + clipul părinte, într-o tranzacție; clipurile
        // șterse nu sunt „înviate”, cele respinse la moderare nu sunt publicate.
        const result = await legacyApproveVideoAsset(videoId);
        if (!result.ok) {
          return NextResponse.json(
            { error: result.error },
            { status: result.error === "not_found" ? 404 : 409 }
          );
        }
        const v = result.video;
        autoEmbedVideo(v.video_id, v.title, v.description);

        // Fire-and-forget creator email notification (doar cu date reale — fără
        // texte de rezervă hardcodate).
        notifyCreatorByEmail(videoId, (email, name, title) => notifyVideoApproved(email, name, title));

        await logAdminAction({
          action: "video.approve",
          targetType: "video_asset",
          targetId: videoId,
          details: { videoId: v.video_id, moderationStatus: v.moderation_status },
          req,
          actor,
        });

        return NextResponse.json({ success: true, action: "approve", videoId: v.video_id });
      }

      case "reject": {
        const customReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
        // Cod stabil în DB când adminul nu scrie un motiv.
        const rejectReason = customReason || VIDEO_REJECT_DEFAULT_REASON;
        const result = await legacyRejectVideoAsset(videoId, rejectReason);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 404 });
        }

        // Notificare localizată în aplicație; email-ul (cu motiv) doar când
        // adminul a scris un motiv real.
        if (result.video.creator_id) {
          notifyLocalized(result.video.creator_id, "videoRejected", { url: "/creator" }).catch((err) =>
            logger.warn({ err, videoId }, "[Admin Videos] reject notification failed"),
          );
        }
        if (customReason) {
          notifyCreatorByEmail(videoId, (email, name, title) => notifyVideoRejected(email, name, title, customReason));
        }

        await logAdminAction({
          action: "video.reject",
          targetType: "video_asset",
          targetId: videoId,
          details: { reason: rejectReason, videoId: result.video.video_id },
          req,
          actor,
        });

        return NextResponse.json({ success: true, action: "reject", videoId: result.video.video_id });
      }

      case "reprocess": {
        if (!(await videoAssetIsLive(dbQuery, videoId))) {
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        }
        // Use correct column name: asset_id, not video_asset_id
        await dbQuery(
          `INSERT INTO video_processing_jobs (video_id, asset_id, job_type, status, priority)
           VALUES ((SELECT video_id FROM video_assets WHERE id = $1), $1, 'transcode', 'queued', 100)`,
          [videoId]
        );
        await logAdminAction({
          action: "video.reprocess",
          targetType: "video_asset",
          targetId: videoId,
          req,
          actor,
        });

        return NextResponse.json({ success: true, action: "reprocess" });
      }

      case "import_url": {
        // Procesarea unui video NOU dintr-un URL extern prin pipeline-ul hibrid
        // (download → FFmpeg → HLS → storage). `videoId` e ignorat aici.
        const sourceUrl: string | undefined = body.sourceUrl || body.source_url || body.video_url;
        if (!sourceUrl) {
          return NextResponse.json(
            { error: "source_url_required" },
            { status: 400 }
          );
        }

        const result = await enqueueVideoPipeline({
          sourceUrl,
          title: body.title,
          description: body.description,
          productRefs: Array.isArray(body.productRefs) ? body.productRefs : undefined,
          tags: Array.isArray(body.tags) ? body.tags : undefined,
          creatorId: typeof body.creatorId === "string" && body.creatorId ? body.creatorId : undefined,
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
        });

        await logAdminAction({
          action: "video.import_url",
          targetType: "video",
          targetId: result.videoId,
          details: { sourceUrl },
          req,
          actor,
        });

        return NextResponse.json(
          {
            success: true,
            action: "import_url",
            ...result,
          },
          { status: 202 }
        );
      }

      default:
        return NextResponse.json(
          { error: "unknown_action" },
          { status: 400 }
        );
    }
  } catch (error) {
    logger.error({ err: error }, "[Admin Videos] POST error:");
    return NextResponse.json(
      { error: "action_failed" },
      { status: 500 }
    );
  }
}
