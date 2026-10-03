/**
 * POST /api/creator/upload-session/[id]/complete
 *
 * Închide uploadul multipart și pornește procesarea. Nu are încredere în client:
 * lista părților vine din S3 (ListParts), mărimea obiectului final e verificată
 * cu HEAD. Idempotent: un al doilea apel (retry de rețea, dublu tap) întoarce
 * jobul existent și îl republică în coadă dacă e încă 'queued'.
 */
import { getDb } from "@/lib/db";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import {
  completeMultipartUpload,
  headObject,
  listUploadedParts,
  type UploadedPart,
} from "@/lib/video/storage-multipart";
import { UploadInputError } from "@/lib/video/upload-session";
import { enqueueOrThrow, insertTranscodeJob, type TranscodeJobSource } from "@/lib/video/upload/jobs";
import { loadSession, type UploadSessionRow } from "@/lib/video/upload/session-repo";

export type TrimInput = { startMs: number | null; endMs: number | null };

export type CompletedUpload = { videoId: string; jobId: string | null; status: "processing" | "ready" };

export function validateTrim(trim: TrimInput): TrimInput {
  const startMs = trim.startMs && trim.startMs > 0 ? Math.floor(trim.startMs) : null;
  const endMs = trim.endMs && trim.endMs > 0 ? Math.floor(trim.endMs) : null;
  if (endMs !== null) {
    const length = endMs - (startMs ?? 0);
    if (length < VIDEO_LIMITS.minDurationMs) throw new UploadInputError("trim too short", "duration_too_short");
    if (length > VIDEO_LIMITS.maxDurationMs + VIDEO_LIMITS.durationToleranceMs) {
      throw new UploadInputError("trim too long", "duration_too_long");
    }
  }
  return { startMs, endMs };
}

/** Verifică părțile raportate de S3 față de ce s-a declarat la init. */
export function checkParts(parts: UploadedPart[], totalParts: number, byteSize: number): number[] {
  const have = new Set(parts.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let n = 1; n <= totalParts; n += 1) if (!have.has(n)) missing.push(n);
  if (missing.length > 0) return missing;
  const total = parts.reduce((sum, p) => sum + p.size, 0);
  if (byteSize > 0 && total !== byteSize) throw new UploadInputError("size mismatch", "size_mismatch", 422);
  return [];
}

function jobSource(session: UploadSessionRow, trim: TrimInput): TranscodeJobSource {
  return {
    sessionId: session.id,
    videoId: session.video_id,
    assetId: session.asset_id ?? "",
    creatorId: session.user_id,
    bucket: session.bucket,
    objectKey: session.object_key,
    contentType: session.content_type,
    byteSize: Number(session.byte_size || 0),
    productRefs: session.product_refs,
    metadata: session.video_metadata,
    trimStartMs: trim.startMs,
    trimEndMs: trim.endMs,
  };
}

async function finalizeObject(session: UploadSessionRow): Promise<void> {
  const byteSize = Number(session.byte_size || 0);
  const uploadId = session.upload_id || "";
  const parts = await listUploadedParts(session.object_key, uploadId).catch(() => null);
  if (parts) {
    const missing = checkParts(parts, Number(session.total_parts || 1), byteSize);
    if (missing.length > 0) {
      throw Object.assign(new UploadInputError("upload incomplete", "upload_incomplete", 409), { missing });
    }
    await completeMultipartUpload(session.object_key, uploadId, parts);
  }
  // ListParts eșuează după un complete reușit (NoSuchUpload) — HEAD decide.
  const head = await headObject(session.object_key);
  if (!head) throw new UploadInputError("object missing", "upload_incomplete", 409);
  if (head.size > VIDEO_LIMITS.maxBytes) throw new UploadInputError("file too large", "file_too_large", 413);
  if (byteSize > 0 && head.size !== byteSize) throw new UploadInputError("size mismatch", "size_mismatch", 422);
}

export async function completeUploadSession(
  sessionId: string,
  userId: string,
  rawTrim: TrimInput,
): Promise<CompletedUpload> {
  const session = await loadSession(sessionId, userId);
  if (!session) throw new UploadInputError("session not found", "not_found", 404);
  if (session.status === "aborted" || session.status === "expired") {
    throw new UploadInputError("session closed", "session_closed", 409);
  }
  if (!session.asset_id) throw new UploadInputError("source asset missing", "not_found", 404);

  const trim =
    session.status === "completed"
      ? { startMs: session.trim_start_ms, endMs: session.trim_end_ms }
      : validateTrim(rawTrim);
  if (session.status !== "completed") await finalizeObject(session);

  const client = await getDb().connect();
  let job: Awaited<ReturnType<typeof insertTranscodeJob>>;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE video_upload_sessions
          SET status = 'completed', completed_at = COALESCE(completed_at, NOW()),
              trim_start_ms = $3, trim_end_ms = $4, updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId, trim.startMs, trim.endMs],
    );
    await client.query(
      `UPDATE video_assets SET status = 'available', updated_at = NOW() WHERE id = $1`,
      [session.asset_id],
    );
    await client.query(
      `UPDATE videos
          SET status = CASE WHEN status = 'ready' THEN status ELSE 'processing' END,
              metadata = metadata || jsonb_build_object('upload_completed_at', NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [session.video_id],
    );
    const { rows } = await client.query<{ status: string }>(`SELECT status FROM videos WHERE id = $1`, [
      session.video_id,
    ]);
    if (rows[0]?.status === "ready") {
      await client.query("COMMIT");
      return { videoId: session.video_id, jobId: null, status: "ready" };
    }
    job = await insertTranscodeJob(client, jobSource(session, trim));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await enqueueOrThrow(job.payload);
  return { videoId: session.video_id, jobId: job.jobId, status: "processing" };
}
