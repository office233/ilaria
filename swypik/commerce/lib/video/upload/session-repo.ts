/** Acces DB pentru sesiunile de upload video (video_upload_sessions + clip + job). */
import { dbQuery } from "@/lib/db";

export type UploadSessionRow = {
  id: string;
  user_id: string;
  video_id: string;
  bucket: string;
  object_key: string;
  upload_id: string | null;
  status: string;
  byte_size: string | number | null;
  content_type: string | null;
  part_size: string | number | null;
  total_parts: number | null;
  trim_start_ms: number | null;
  trim_end_ms: number | null;
  expires_at: string;
  asset_id: string | null;
  product_refs: unknown;
  video_metadata: Record<string, unknown> | null;
};

export async function loadSession(sessionId: string, userId: string): Promise<UploadSessionRow | null> {
  const { rows } = await dbQuery<UploadSessionRow>(
    `SELECT vus.id, vus.user_id, vus.video_id, vus.bucket, vus.object_key, vus.upload_id,
            vus.status, vus.byte_size, vus.content_type, vus.part_size, vus.total_parts,
            vus.trim_start_ms, vus.trim_end_ms, vus.expires_at,
            va.id AS asset_id, v.product_refs, v.metadata AS video_metadata
       FROM video_upload_sessions vus
       JOIN videos v ON v.id = vus.video_id
       LEFT JOIN video_assets va ON va.video_id = v.id AND va.asset_type = 'source'
      WHERE vus.id = $1 AND vus.user_id = $2
      LIMIT 1`,
    [sessionId, userId],
  );
  return rows[0] ?? null;
}

export type UploadStatusRow = {
  session_id: string;
  upload_status: string;
  byte_size: string | number | null;
  total_parts: number | null;
  video_id: string;
  video_status: string;
  visibility: string;
  moderation_status: string;
  title: string | null;
  thumbnail_url: string | null;
  playback_url: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  job_id: string | null;
  job_status: string | null;
  job_stage: string | null;
  job_progress: number | null;
  job_error_code: string | null;
  attempt_count: number | null;
  max_attempts: number | null;
  created_at: string;
};

const STATUS_SELECT = `
  SELECT vus.id AS session_id, vus.status AS upload_status, vus.byte_size, vus.total_parts,
         v.id AS video_id, v.status AS video_status, v.visibility, v.moderation_status, v.title,
         v.thumbnail_url, v.playback_url, v.duration_ms, v.width, v.height,
         vpj.id AS job_id, vpj.status AS job_status, vpj.stage AS job_stage,
         vpj.progress AS job_progress, vpj.error_code AS job_error_code,
         vpj.attempt_count, vpj.max_attempts, vus.created_at
    FROM video_upload_sessions vus
    JOIN videos v ON v.id = vus.video_id
    LEFT JOIN LATERAL (
      SELECT id, status, stage, progress, error_code, attempt_count, max_attempts
        FROM video_processing_jobs
       WHERE video_id = v.id AND job_type = 'transcode'
       ORDER BY created_at DESC
       LIMIT 1
    ) vpj ON true`;

export async function loadStatusRow(sessionId: string, userId: string): Promise<UploadStatusRow | null> {
  const { rows } = await dbQuery<UploadStatusRow>(
    `${STATUS_SELECT} WHERE vus.id = $1 AND vus.user_id = $2 LIMIT 1`,
    [sessionId, userId],
  );
  return rows[0] ?? null;
}

/** Sesiunile neterminate ale userului (pentru bannerul „reia uploadul”). */
export async function listOpenSessions(userId: string, limit = 5): Promise<UploadStatusRow[]> {
  const { rows } = await dbQuery<UploadStatusRow>(
    `${STATUS_SELECT}
      WHERE vus.user_id = $1
        AND vus.status IN ('created', 'uploading')
        AND vus.expires_at > NOW()
        AND v.status = 'uploading'
      ORDER BY vus.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
