/**
 * DELETE /api/creator/upload-session/[id] — anularea unui upload în curs.
 * Abort pe multipart (eliberează părțile din bucket), sesiunea devine
 * 'aborted', clipul draft e arhivat soft (status 'deleted', ascuns).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { abortMultipartUpload } from "@/lib/video/storage-multipart";
import { UploadInputError } from "@/lib/video/upload-session";
import { loadSession } from "@/lib/video/upload/session-repo";

export async function abortUploadSession(sessionId: string, userId: string): Promise<{ aborted: boolean }> {
  const session = await loadSession(sessionId, userId);
  if (!session) throw new UploadInputError("session not found", "not_found", 404);
  if (session.status === "completed") throw new UploadInputError("already completed", "already_completed", 409);
  if (session.status === "aborted") return { aborted: true };

  if (session.upload_id) {
    await abortMultipartUpload(session.object_key, session.upload_id).catch((err) =>
      logger.warn({ err, sessionId }, "[upload] multipart abort failed (lifecycle rule will clean up)"),
    );
  }
  await dbQuery(
    `UPDATE video_upload_sessions SET status = 'aborted', updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  await dbQuery(
    `UPDATE videos SET status = 'deleted', is_hidden = true, hidden_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'uploading'`,
    [session.video_id],
  );
  if (session.asset_id) {
    await dbQuery(`UPDATE video_assets SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [session.asset_id]);
  }
  return { aborted: true };
}
