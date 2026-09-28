/**
 * Curățenie pentru uploadurile abandonate (apelată de cron/watchdog-videos):
 * sesiunile multipart expirate primesc Abort (părțile nu mai ocupă spațiu în
 * bucket), iar draftul rămas 'uploading' e marcat 'failed' (cod upload_expired).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { abortMultipartUpload } from "@/lib/video/storage-multipart";

export async function expireAbandonedUploads(limit = 100): Promise<number> {
  const { rows } = await dbQuery<{ id: string; video_id: string; object_key: string; upload_id: string | null }>(
    `UPDATE video_upload_sessions
        SET status = 'expired', updated_at = NOW()
      WHERE id IN (
        SELECT id FROM video_upload_sessions
         WHERE status IN ('created', 'uploading') AND expires_at < NOW()
         ORDER BY expires_at ASC
         LIMIT $1
      )
      RETURNING id, video_id, object_key, upload_id`,
    [limit],
  );
  for (const s of rows) {
    if (s.upload_id && s.upload_id !== s.id) {
      await abortMultipartUpload(s.object_key, s.upload_id).catch((err) =>
        logger.warn({ err, sessionId: s.id }, "[upload-expire] abort failed"),
      );
    }
  }
  if (rows.length > 0) {
    await dbQuery(
      `UPDATE videos
          SET status = 'failed',
              metadata = metadata || '{"error_code":"upload_expired"}'::jsonb,
              updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND status = 'uploading'`,
      [rows.map((s) => s.video_id)],
    );
  }
  return rows.length;
}
