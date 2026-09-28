/**
 * Starea reală a unui upload/procesări, derivată din sesiune + clip + ultimul
 * job (etapă/procent scrise de worker). Nimic simulat: dacă workerul nu a
 * raportat încă un procent, UI-ul arată o bară nedeterminată.
 */
import type { UploadStatusRow } from "@/lib/video/upload/session-repo";

export type UploadPhase = "uploading" | "queued" | "processing" | "ready" | "failed" | "aborted";

export type UploadStatus = {
  sessionId: string;
  videoId: string;
  phase: UploadPhase;
  stage: string | null;
  progress: number | null;
  errorCode: string | null;
  canRetry: boolean;
  attempts: number;
  maxAttempts: number;
  title: string | null;
  visibility: string;
  moderationStatus: string;
  thumbnailUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  totalParts: number | null;
  byteSize: number;
  createdAt: string;
};

/** Coduri de eroare pe care un retry nu le poate repara (sursa e invalidă). */
const PERMANENT_ERRORS = new Set(["duration_too_long", "duration_too_short", "no_video_stream", "invalid_source"]);

export function derivePhase(row: Pick<UploadStatusRow, "upload_status" | "video_status" | "job_status">): UploadPhase {
  if (row.upload_status === "aborted" || row.upload_status === "expired" || row.video_status === "deleted") {
    return "aborted";
  }
  if (row.video_status === "ready") return "ready";
  if (row.video_status === "failed" || row.job_status === "failed") return "failed";
  if (row.upload_status !== "completed") return "uploading";
  if (row.job_status === "running") return "processing";
  return "queued";
}

export function toUploadStatus(row: UploadStatusRow): UploadStatus {
  const phase = derivePhase(row);
  const errorCode = phase === "failed" ? row.job_error_code || "internal_error" : null;
  return {
    sessionId: row.session_id,
    videoId: row.video_id,
    phase,
    stage: phase === "processing" || phase === "queued" ? row.job_stage : phase === "ready" ? "done" : null,
    progress: phase === "ready" ? 100 : typeof row.job_progress === "number" ? row.job_progress : null,
    errorCode,
    canRetry: phase === "failed" && !PERMANENT_ERRORS.has(errorCode ?? ""),
    attempts: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    title: row.title,
    visibility: row.visibility,
    moderationStatus: row.moderation_status,
    thumbnailUrl: row.thumbnail_url,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    totalParts: row.total_parts,
    byteSize: Number(row.byte_size || 0),
    createdAt: row.created_at,
  };
}
