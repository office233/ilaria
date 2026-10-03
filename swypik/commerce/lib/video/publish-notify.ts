/**
 * Notificarea followerilor la un clip nou — o singură dată per clip și doar
 * când clipul chiar se vede în feed (ready + public + aprobat). Apelată la
 * publicare, la aprobarea unui admin și din cronul publish-scheduled (care
 * prinde și clipurile publicate cât încă se procesau). Tot aici se acordă XP-ul
 * „primul clip publicat" (Arcade) — momentul unic în care clipul devine vizibil.
 */
import { dbQuery } from "@/lib/db";
import { awardMilestoneXp } from "@/lib/gaming/activity-xp";
import { logger } from "@/lib/logger";
import { notifyFollowersNewPost } from "@/lib/notifications/dispatch";

export async function notifyFollowersOnce(videoId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ creator_id: string }>(
    `UPDATE videos
        SET metadata = metadata || jsonb_build_object('followers_notified_at', NOW())
      WHERE id = $1
        AND status = 'ready'
        AND visibility = 'public'
        AND moderation_status = 'approved'
        AND NOT (metadata ? 'followers_notified_at')
      RETURNING creator_id`,
    [videoId],
  );
  const creatorId = rows[0]?.creator_id;
  if (!creatorId) return false;
  notifyFollowersNewPost(creatorId, videoId).catch((err) =>
    logger.warn({ err, videoId }, "[publish-notify] fan-out failed"),
  );
  // Primul clip ajuns în feed → XP „first_upload" (idempotent, nu aruncă niciodată).
  await awardMilestoneXp(creatorId, "first_upload");
  return true;
}

/** Clipurile publicate recent care încă nu și-au notificat followerii. */
export async function notifyPendingPublishedVideos(limit = 50): Promise<number> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM videos
      WHERE status = 'ready' AND visibility = 'public' AND moderation_status = 'approved'
        AND published_at > NOW() - INTERVAL '24 hours'
        AND NOT (metadata ? 'followers_notified_at')
      ORDER BY published_at ASC
      LIMIT $1`,
    [limit],
  );
  let sent = 0;
  for (const row of rows) if (await notifyFollowersOnce(row.id)) sent += 1;
  return sent;
}
