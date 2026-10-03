/**
 * lib/video/pipeline.ts
 *
 * Creates a video processing job that pulls a source from an external URL
 * through the same pipeline used by creator uploads:
 *
 *     external URL  ─►  video_upload_sessions (source_url)
 *                  ─►  videos (status='processing', playback_url=NULL)
 *                  ─►  video_assets (asset_type='source', status='uploading')
 *                  ─►  video_processing_jobs (status='queued')
 *                  ─►  Redis stream `video:jobs`
 *
 * The Python worker downloads from `source_url`, transcodes to HLS, uploads
 * to R2, and finally UPDATEs `videos.playback_url` / `videos.thumbnail_url`
 * + status='ready' (handled by workers/video-worker/video_worker/db.py).
 *
 * Entry point for admin flows that (re)process a video from a source URL,
 * e.g. POST /api/admin/videos/[id]/reencode.
 */

import { randomUUID } from "node:crypto";
import { dbQuery, getDb } from "@/lib/db";
import { getVideoStorageBucket, VIDEO_PATHS } from "@/lib/storage/video-storage";
import { publishProcessVideoJob } from "@/lib/video/redis-queue";
import { buildProcessVideoJobPayload, storageProviderFromEnv } from "@/lib/video/upload-session";

const SYSTEM_CREATOR_ID = "00000000-0000-0000-0000-000000000001";

export type VideoPipelineInput = {
  sourceUrl: string;
  title?: string;
  description?: string;
  productRefs?: Array<{ product_id?: string }>;
  tags?: string[];
  /** If provided, attach the job to this existing video (re-encode flow). */
  existingVideoId?: string;
  /** Override creator (defaults to swypik system creator). */
  creatorId?: string;
  /** Free-form bag stored in videos.metadata + job.metadata. */
  metadata?: Record<string, unknown>;
};

export type VideoPipelineResult = {
  videoId: string;
  sessionId: string;
  assetId: string;
  jobId: string;
  rawObjectKey: string;
  queued: boolean;
  queueBackend: string;
  queueError?: string;
};

/**
 * Create (or re-encode) a video that sources its bytes from `sourceUrl`.
 *
 * - When `existingVideoId` is omitted, a brand-new `videos` row is created with
 *   status='processing' and `playback_url=NULL`. The worker fills these in.
 * - When `existingVideoId` is given (re-encode), the video row is reused and
 *   its status is flipped back to 'processing'.
 */
export async function enqueueVideoPipeline(input: VideoPipelineInput): Promise<VideoPipelineResult> {
  if (!input.sourceUrl || !/^https?:\/\//i.test(input.sourceUrl)) {
    throw new Error("sourceUrl must be an http(s) URL");
  }

  const creatorId = input.creatorId || SYSTEM_CREATOR_ID;
  const storageProvider = storageProviderFromEnv();
  const bucket = getVideoStorageBucket();
  const videoId = input.existingVideoId || randomUUID();
  const sessionId = randomUUID();
  const assetId = randomUUID();
  const jobId = randomUUID();
  const rawObjectKey = `${VIDEO_PATHS.raw}/${videoId}.mp4`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
  const title = (input.title || "Untitled").slice(0, 280);
  const description = input.description || "";
  const productRefs = input.productRefs || [];
  const tags = input.tags || [];

  const baseMetadata = {
    ...(input.metadata || {}),
    source: "external_import",
    source_url: input.sourceUrl,
    raw_object_key: rawObjectKey,
    upload_session_id: sessionId,
    source_asset_id: assetId,
    process_video_job_id: jobId,
  };

  const payload = buildProcessVideoJobPayload({
    jobId,
    uploadId: sessionId,
    videoId,
    assetId,
    creatorId,
    bucket,
    sourceKey: rawObjectKey,
    sourceUrl: input.sourceUrl,
    contentType: "video/mp4",
    byteSize: 0,
    metadata: baseMetadata,
  });

  const client = await getDb().connect();
  try {
    await client.query("BEGIN");

    if (input.existingVideoId) {
      // Re-encode: keep the row, flip status back to processing and clear stale URLs.
      await client.query(
        `
        UPDATE videos
        SET status = 'processing',
            playback_url = NULL,
            metadata = metadata || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [videoId, JSON.stringify(baseMetadata)]
      );
    } else {
      await client.query(
        `
        INSERT INTO videos (
          id, creator_id, title, description, visibility, status,
          product_refs, tags, metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'draft', 'processing',
                $5::jsonb, $6::text[], $7::jsonb, NOW(), NOW())
        `,
        [
          videoId,
          creatorId,
          title,
          description,
          JSON.stringify(productRefs),
          tags,
          JSON.stringify(baseMetadata),
        ]
      );
    }

    await client.query(
      `
      INSERT INTO video_upload_sessions (
        id, user_id, video_id, storage_provider, bucket, object_key, upload_id,
        status, byte_size, content_type, source_url, expires_at,
        metadata, created_at, updated_at
      )
      VALUES ($1::uuid, $2, $3, $9, $4, $5, $1::text, 'completed', 0, 'video/mp4',
              $6, $7, $8::jsonb, NOW(), NOW())
      `,
      [
        sessionId,
        creatorId,
        videoId,
        bucket,
        rawObjectKey,
        input.sourceUrl,
        expiresAt,
        JSON.stringify(baseMetadata),
        storageProvider,
      ]
    );

    const assetResult = await client.query<{ id: string }>(
      `
      INSERT INTO video_assets (
        id, video_id, asset_type, storage_provider, bucket, object_key,
        mime_type, byte_size, status, metadata, created_at, updated_at
      )
      VALUES ($1, $2, 'source', $6, $3, $4, 'video/mp4', 0,
              'uploading', $5::jsonb, NOW(), NOW())
      ON CONFLICT (storage_provider, bucket, object_key) DO UPDATE
        SET status = 'uploading',
            metadata = video_assets.metadata || EXCLUDED.metadata,
            updated_at = NOW()
      RETURNING id
      `,
      [assetId, videoId, bucket, rawObjectKey, JSON.stringify(baseMetadata), storageProvider]
    );
    const effectiveAssetId = assetResult.rows[0]?.id ?? assetId;

    await client.query(
      `
      INSERT INTO video_processing_jobs (
        id, video_id, asset_id, job_type, status, priority, attempt_count,
        max_attempts, scheduled_at, source_url, payload, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'transcode', 'queued', 100, 0, 3, NOW(),
              $4, $5::jsonb, NOW(), NOW())
      `,
      [jobId, videoId, effectiveAssetId, input.sourceUrl, JSON.stringify(payload)]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const queue = await publishProcessVideoJob(payload);

  return {
    videoId,
    sessionId,
    assetId,
    jobId,
    rawObjectKey,
    queued: queue.queued,
    queueBackend: queue.backend,
    queueError: queue.error,
  };
}

/**
 * Lookup helper used by the re-encode route. Returns the best candidate
 * external URL for a video — checks (in order):
 *   1. `videos.metadata.source_url`
 *   2. `videos.playback_url` dacă e un URL http(s) extern
 */
export async function findExternalSourceUrlForVideo(videoId: string): Promise<string | null> {
  const { rows } = await dbQuery<{
    playback_url: string | null;
    metadata: unknown;
    product_refs: unknown;
  }>(
    `SELECT playback_url, metadata, product_refs FROM videos WHERE id = $1 LIMIT 1`,
    [videoId]
  );
  const row = rows[0];
  if (!row) return null;

  const metadata = typeof row.metadata === "string" ? safeJson(row.metadata) : row.metadata;
  const fromMeta = metadata && typeof metadata === "object" ? (metadata as { source_url?: unknown }).source_url : null;
  if (typeof fromMeta === "string" && /^https?:\/\//i.test(fromMeta)) return fromMeta;

  // Fallback: playback_url extern e folosit direct ca sursă.
  if (row.playback_url && /^https?:\/\//i.test(row.playback_url)) return row.playback_url;
  return null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
