/**
 * Legătura video → misiune (înscrierea unui clip). Folosită de:
 *   - PATCH /api/creator/videos/[id]   { missionId }   (pickerul din upload)
 *   - POST  /api/missions/[slug]/submit { videoId }    (butonul de pe misiune)
 *
 * Reguli:
 *   - misiunea e deschisă (OPEN_MISSION_SQL: activă, finanțată, în interval);
 *   - clipul aparține userului și nu e șters/respins/eșuat (poate fi încă în
 *     procesare — jurizarea vede doar clipurile publicate);
 *   - un clip participă la o singură misiune (index unic parțial pe video_id);
 *   - creatorul misiunii (sellerul) nu se poate înscrie la propria misiune.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { OPEN_MISSION_SQL } from "./repo";

export type LinkResult =
  | { ok: true; submissionId: string; alreadyLinked: boolean }
  | {
      ok: false;
      code: "mission_not_open" | "video_not_eligible" | "video_in_other_mission" | "own_mission";
    };

// videos.status (CHECK): uploading/processing/ready/failed/archived/deleted — nu există "published"
// (publicat = visibility public). Respinsele la moderare au moderation_status = rejected.
const INELIGIBLE_VIDEO_STATUSES = ["deleted", "failed", "archived"];

export async function linkVideoToMission(args: {
  userId: string;
  videoId: string;
  missionId: string;
}): Promise<LinkResult> {
  const { userId, videoId, missionId } = args;

  const { rows: missions } = await dbQuery<{ id: string; owner_user_id: string | null }>(
    `SELECT m.id, COALESCE(m.created_by_user_id, s.user_id) AS owner_user_id
       FROM creator_missions m
       LEFT JOIN sellers s ON s.id = m.seller_id
      WHERE m.id = $1 AND ${OPEN_MISSION_SQL}`,
    [missionId],
  );
  const mission = missions[0];
  if (!mission) return { ok: false, code: "mission_not_open" };
  if (mission.owner_user_id && mission.owner_user_id === userId) {
    return { ok: false, code: "own_mission" };
  }

  const { rows: videos } = await dbQuery<{ id: string }>(
    `SELECT id FROM videos
      WHERE id = $1 AND creator_id = $2 AND NOT (status = ANY($3::text[]))
        AND moderation_status IS DISTINCT FROM 'rejected'`,
    [videoId, userId, INELIGIBLE_VIDEO_STATUSES],
  );
  if (!videos[0]) return { ok: false, code: "video_not_eligible" };

  const { rows: existing } = await dbQuery<{ id: string; mission_id: string }>(
    `SELECT id, mission_id FROM creator_mission_submissions
      WHERE video_id = $1 AND status <> 'rejected' LIMIT 1`,
    [videoId],
  );
  if (existing[0]) {
    if (existing[0].mission_id === missionId) {
      return { ok: true, submissionId: existing[0].id, alreadyLinked: true };
    }
    return { ok: false, code: "video_in_other_mission" };
  }

  try {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO creator_mission_submissions (mission_id, user_id, video_id, payout_currency)
       VALUES ($1, $2, $3, 'RON')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [missionId, userId, videoId],
    );
    if (!rows[0]) return { ok: false, code: "video_in_other_mission" };
    logger.info({ missionId, userId, videoId }, "mission.submission.created");
    return { ok: true, submissionId: rows[0].id, alreadyLinked: false };
  } catch (err) {
    // Cursă pe indexul unic parțial (același clip, două cereri simultane).
    if ((err as { code?: string }).code === "23505") {
      return { ok: false, code: "video_in_other_mission" };
    }
    throw err;
  }
}

/**
 * Scoate clipul din misiune (missionId: null în PATCH). Doar înscrierile încă
 * nejurizate — un câștigător nu poate fi retras de creator.
 */
export async function unlinkVideoFromMission(args: { userId: string; videoId: string }): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `DELETE FROM creator_mission_submissions
      WHERE video_id = $1 AND user_id = $2 AND status IN ('submitted', 'approved')`,
    [args.videoId, args.userId],
  );
  return (rowCount ?? 0) > 0;
}

/** HTTP status pentru codurile de mai sus (comun rutelor). */
export function linkErrorStatus(code: Exclude<LinkResult, { ok: true }>["code"]): number {
  switch (code) {
    case "mission_not_open":
      return 404;
    case "video_not_eligible":
    case "own_mission":
      return 403;
    case "video_in_other_mission":
      return 409;
  }
}
