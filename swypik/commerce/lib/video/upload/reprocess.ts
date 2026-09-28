/**
 * POST /api/creator/videos/[id]/reprocess — „Reîncearcă” după o procesare eșuată.
 * Refolosește sursa deja urcată (fără re-upload), creează un job nou și îl
 * publică în coadă. Nu reîncearcă erorile permanente (sursă invalidă / prea lungă).
 */
import { dbQuery, getDb } from "@/lib/db";
import { headObject } from "@/lib/video/storage-multipart";
import { UploadInputError } from "@/lib/video/upload-session";
import { enqueueOrThrow, insertTranscodeJob } from "@/lib/video/upload/jobs";

const NOT_RETRYABLE = new Set(["duration_too_long", "duration_too_short", "no_video_stream", "invalid_source"]);

type SourceRow = {
  session_id: string;
  user_id: string;
  bucket: string;
  object_key: string;
  content_type: string | null;
  byte_size: string | number | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  asset_id: string;
  status: string;
  product_refs: unknown;
  metadata: Record<string, unknown> | null;
  last_error_code: string | null;
};

/**
 * `reencode: true` (admin) — re-transcodează și un clip deja „ready” din sursa
 * păstrată în bucket (ex. clipurile vechi 16:9 cu benzi negre → randări 9:16).
 */
export async function reprocessVideo(videoId: string, opts: { reencode?: boolean } = {}): Promise<{ jobId: string }> {
  const { rows } = await dbQuery<SourceRow>(
    `SELECT vus.id AS session_id, vus.user_id, vus.bucket, vus.object_key, vus.content_type, vus.byte_size,
            vus.trim_start_ms, vus.trim_end_ms, va.id AS asset_id, v.status, v.product_refs, v.metadata,
            (SELECT error_code FROM video_processing_jobs j
              WHERE j.video_id = v.id ORDER BY j.created_at DESC LIMIT 1) AS last_error_code
       FROM videos v
       JOIN video_upload_sessions vus ON vus.video_id = v.id AND vus.status = 'completed'
       JOIN video_assets va ON va.video_id = v.id AND va.asset_type = 'source'
      WHERE v.id = $1
      ORDER BY vus.created_at DESC
      LIMIT 1`,
    [videoId],
  );
  const src = rows[0];
  if (!src) throw new UploadInputError("no uploaded source", "not_found", 404);
  if (!opts.reencode && src.status !== "failed") throw new UploadInputError("video is not failed", "not_failed", 409);
  if (!opts.reencode && NOT_RETRYABLE.has(src.last_error_code ?? "")) {
    throw new UploadInputError("source cannot be processed", src.last_error_code ?? "invalid_source", 422);
  }
  if (!(await headObject(src.object_key))) throw new UploadInputError("source missing", "source_missing", 410);

  const client = await getDb().connect();
  let job: Awaited<ReturnType<typeof insertTranscodeJob>>;
  try {
    await client.query("BEGIN");
    // Re-encode (admin / remix de sunet): `is_hidden` rămâne cum l-a lăsat moderarea —
    // altfel un clip ascuns de moderatori redevenea vizibil. Doar reîncercarea unui
    // draft eșuat îl scoate din ascuns.
    const unhide = opts.reencode ? "" : "is_hidden = false, hidden_at = NULL, ";
    await client.query(
      `UPDATE videos
          SET status = 'processing',
              ${unhide}visibility = CASE WHEN visibility = 'private' AND published_at IS NULL THEN 'draft' ELSE visibility END,
              metadata = (metadata - 'error_message' - 'error_code'),
              updated_at = NOW()
        WHERE id = $1`,
      [videoId],
    );
    job = await insertTranscodeJob(client, {
      sessionId: src.session_id,
      videoId,
      assetId: src.asset_id,
      creatorId: src.user_id,
      bucket: src.bucket,
      objectKey: src.object_key,
      contentType: src.content_type,
      byteSize: Number(src.byte_size || 0),
      productRefs: src.product_refs,
      metadata: src.metadata,
      trimStartMs: src.trim_start_ms,
      trimEndMs: src.trim_end_ms,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await enqueueOrThrow(job.payload);
  return { jobId: job.jobId };
}
