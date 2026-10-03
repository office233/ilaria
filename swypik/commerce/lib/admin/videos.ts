/**
 * Acțiunile „legacy” din /admin/videos (panoul de procesare pe video_assets):
 * aprobare / respingere a unui asset sursă.
 *
 * Reguli (aliniate cu decideVideo din lib/admin/moderation/video-decision.ts):
 *  - un clip șters (videos.status = 'deleted') NU poate fi „înviat”: → not_found;
 *  - aprobarea unui clip respins la moderare e refuzată (→ moderation_rejected):
 *    decizia de moderare se schimbă doar din coada de moderare;
 *  - aprobarea unui clip „pending_review” îl marchează și moderation_status =
 *    'approved' (altfel ar fi fost public dar invizibil/inconsistent în feed);
 *  - respingerea setează moderation_status = 'rejected' + ascuns.
 * Motivul implicit al respingerii e un cod stabil, nu o propoziție.
 */
import { withTransaction } from "@/lib/db";

export const VIDEO_REJECT_DEFAULT_REASON = "rejected_by_admin";

export type LegacyVideoRow = {
  video_id: string;
  moderation_status: string | null;
  title: string | null;
  description: string | null;
  creator_id: string | null;
};

export type LegacyVideoResult =
  | { ok: true; video: LegacyVideoRow }
  | { ok: false; error: "not_found" | "moderation_rejected" };

const LOCK_SQL = `SELECT v.id::text AS video_id, v.moderation_status, v.title, v.description,
                         v.creator_id::text AS creator_id
                    FROM video_assets va
                    JOIN videos v ON v.id = va.video_id
                   WHERE va.id = $1
                     AND COALESCE(v.status, '') <> 'deleted'
                   LIMIT 1
                     FOR UPDATE OF v`;

export async function legacyApproveVideoAsset(assetId: string): Promise<LegacyVideoResult> {
  return withTransaction<LegacyVideoResult>(async (q) => {
    const { rows } = await q<LegacyVideoRow>(LOCK_SQL, [assetId]);
    const v = rows[0];
    if (!v) return { ok: false, error: "not_found" };
    if (v.moderation_status === "rejected") return { ok: false, error: "moderation_rejected" };

    await q(`UPDATE video_assets SET status = 'available' WHERE id = $1`, [assetId]);
    await q(
      `UPDATE videos
          SET status = 'ready',
              moderation_status = CASE WHEN moderation_status = 'pending_review' THEN 'approved' ELSE moderation_status END,
              visibility = CASE WHEN COALESCE(effective_label, 'safe') IN ('adult', 'blocked') THEN 'private' ELSE 'public' END,
              is_hidden = COALESCE(effective_label, 'safe') IN ('adult', 'blocked'),
              published_at = CASE WHEN COALESCE(effective_label, 'safe') IN ('adult', 'blocked') THEN published_at ELSE NOW() END,
              updated_at = NOW()
        WHERE id = $1
          AND COALESCE(status, '') <> 'deleted'`,
      [v.video_id],
    );
    return { ok: true, video: v };
  });
}

export async function legacyRejectVideoAsset(assetId: string, reason: string): Promise<LegacyVideoResult> {
  return withTransaction<LegacyVideoResult>(async (q) => {
    const { rows } = await q<LegacyVideoRow>(LOCK_SQL, [assetId]);
    const v = rows[0];
    if (!v) return { ok: false, error: "not_found" };

    await q(`UPDATE video_assets SET status = 'failed' WHERE id = $1`, [assetId]);
    await q(
      `UPDATE videos
          SET status = 'failed',
              moderation_status = 'rejected',
              visibility = 'private',
              is_hidden = true,
              hidden_at = COALESCE(hidden_at, now()),
              updated_at = NOW()
        WHERE id = $1
          AND COALESCE(status, '') <> 'deleted'`,
      [v.video_id],
    );
    await q(
      `INSERT INTO video_processing_jobs (video_id, asset_id, job_type, status, error_message)
       VALUES ($1, $2, 'moderation', 'failed', $3)`,
      [v.video_id, assetId, reason],
    );
    return { ok: true, video: v };
  });
}

/** Asset-ul există și clipul nu e șters (pentru re-procesare). */
export async function videoAssetIsLive(
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>,
  assetId: string,
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM video_assets va JOIN videos v ON v.id = va.video_id
      WHERE va.id = $1 AND COALESCE(v.status, '') <> 'deleted' LIMIT 1`,
    [assetId],
  );
  return rows.length > 0;
}
