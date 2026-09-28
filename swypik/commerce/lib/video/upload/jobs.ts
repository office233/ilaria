/**
 * Crearea jobului de transcodare + publicarea în coada Redis.
 * Un singur job activ per clip (index unic parțial, migrarea 0010): un al
 * doilea `complete` / `reprocess` concurent nu mai dublează munca.
 */
import { randomUUID } from "crypto";
import { dbQuery } from "@/lib/db";
import { publishProcessVideoJob } from "@/lib/video/redis-queue";
import { buildProcessVideoJobPayload, type ProcessVideoJobPayload } from "@/lib/video/upload-session";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

export type TranscodeJobSource = {
  sessionId: string;
  videoId: string;
  assetId: string;
  creatorId: string;
  bucket: string;
  objectKey: string;
  contentType: string | null;
  byteSize: number;
  productRefs: unknown;
  metadata: Record<string, unknown> | null;
  trimStartMs: number | null;
  trimEndMs: number | null;
};

export function firstProductId(productRefs: unknown): string {
  const refs = typeof productRefs === "string" ? safeJson(productRefs) : productRefs;
  if (!Array.isArray(refs) || refs.length === 0) return "";
  const first = refs[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    return String(record.product_id || record.id || "").trim();
  }
  return "";
}

export function buildTranscodePayload(src: TranscodeJobSource, jobId: string): ProcessVideoJobPayload {
  return buildProcessVideoJobPayload({
    jobId,
    uploadId: src.sessionId,
    videoId: src.videoId,
    assetId: src.assetId,
    creatorId: src.creatorId,
    productId: firstProductId(src.productRefs),
    bucket: src.bucket,
    sourceKey: src.objectKey,
    contentType: src.contentType || "video/mp4",
    byteSize: src.byteSize,
    trimStartMs: src.trimStartMs,
    trimEndMs: src.trimEndMs,
    metadata: src.metadata || {},
  });
}

/**
 * Inserează jobul (dacă nu există deja unul activ) și întoarce jobul activ.
 * Rulează în tranzacția apelantului.
 */
export async function insertTranscodeJob(
  client: Queryable,
  src: TranscodeJobSource,
): Promise<{ jobId: string; payload: ProcessVideoJobPayload; created: boolean }> {
  const jobId = randomUUID();
  const payload = buildTranscodePayload(src, jobId);
  const inserted = await client.query(
    `INSERT INTO video_processing_jobs (id, video_id, asset_id, job_type, status, priority, attempt_count,
                                        max_attempts, scheduled_at, stage, progress, payload,
                                        created_at, updated_at)
     VALUES ($1, $2, $3, 'transcode', 'queued', 100, 0, 3, NOW(), 'queued', 0, $4::jsonb, NOW(), NOW())
     ON CONFLICT (video_id) WHERE status IN ('queued', 'running') AND job_type = 'transcode' DO NOTHING
     RETURNING id`,
    [jobId, src.videoId, src.assetId, JSON.stringify(payload)],
  );
  if (inserted.rows.length > 0) return { jobId, payload, created: true };
  const active = await client.query(
    `SELECT id, payload FROM video_processing_jobs
      WHERE video_id = $1 AND job_type = 'transcode' AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1`,
    [src.videoId],
  );
  const row = active.rows[0] as { id: string; payload: ProcessVideoJobPayload } | undefined;
  if (!row) throw new Error("transcode_job_conflict");
  return { jobId: row.id, payload: row.payload, created: false };
}

/** Publică în coadă; dacă Redis nu e disponibil, jobul rămâne 'queued' (watchdog-ul îl reia). */
export async function enqueueOrThrow(payload: ProcessVideoJobPayload): Promise<void> {
  const result = await publishProcessVideoJob(payload);
  if (!result.queued) {
    await dbQuery(
      `UPDATE video_processing_jobs SET error_code = 'queue_unavailable', updated_at = NOW()
        WHERE id = $1 AND status = 'queued'`,
      [payload.job_id],
    ).catch(() => undefined);
    throw Object.assign(new Error("queue_unavailable"), { status: 503, code: "queue_unavailable" });
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
