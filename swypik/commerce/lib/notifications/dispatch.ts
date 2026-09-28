/**
 * Notification dispatcher.
 *
 * Persists an in-app notification row (existing `notifications` table) and
 * fires a Web Push notification (fire-and-forget). Self-notifications are
 * skipped.
 */

import { dbQuery } from "@/lib/db";
import { sendPushToUser, type PushPayload } from "@/lib/push/web-push";
import { logger } from "@/lib/logger";

// Mapped to the existing notifications.notification_type CHECK constraint.
export type NotificationType =
  | "comment"
  | "reply"
  | "mention"
  | "like"
  | "follow"
  | "share"
  | "commission"
  | "system"
  | "upload_processed"
  | "new_post"
  | "message";

export type NotifyInput = {
  type: NotificationType;
  actorUserId?: string | null;
  /** Either "video" or "comment"; mapped to dedicated FK cols. */
  targetType?: "video" | "comment" | null;
  targetId?: string | null;
  /** Stored in notifications.metadata; may contain title/body/url overrides. */
  payload?: Record<string, unknown>;
};

const TITLES: Record<NotificationType, string> = {
  comment: "Comentariu nou",
  reply: "Răspuns nou la comentariul tău",
  mention: "Te-a menționat cineva",
  like: "Cineva ți-a dat like",
  follow: "Ai un nou follower",
  share: "Cineva a distribuit ceva ce ai postat",
  commission: "Comision nou",
  system: "Notificare",
  upload_processed: "Videoclipul tău este gata",
  new_post: "Clip nou de la un creator urmărit",
  // Titlul real e tradus în limba destinatarului (lib/dm/notify.ts).
  message: "Swypik",
};

export async function notifyUser(
  recipientUserId: string,
  input: NotifyInput,
): Promise<void> {
  if (!recipientUserId) return;
  if (input.actorUserId && input.actorUserId === recipientUserId) return;

  const payload = input.payload || {};
  const title = (payload.title as string) || TITLES[input.type];
  const body = (payload.body as string) || "";
  const actionUrl = (payload.url as string) || null;
  const videoId = input.targetType === "video" ? input.targetId : null;
  const commentId = input.targetType === "comment" ? input.targetId : null;

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO notifications
       (user_id, actor_user_id, notification_type, title, body,
        video_id, comment_id, action_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      recipientUserId,
      input.actorUserId || null,
      input.type,
      title,
      body,
      videoId,
      commentId,
      actionUrl,
      JSON.stringify(payload),
    ],
  );

  const notificationId = rows[0]?.id;
  const pushPayload: PushPayload = {
    title,
    body,
    url: actionUrl || "/notifications",
    tag: `${input.type}:${input.targetId || notificationId}`,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge.png",
    notificationId,
    type: input.type,
  };

  // Respect user push preferences (per category). If row absent, default ON.
  const prefMap: Record<string, string> = {
    like: "push_likes",
    comment: "push_comments",
    reply: "push_comments",
    mention: "push_comments",
    follow: "push_follows",
    new_post: "push_follows",
    commission: "push_sales",
    message: "push_messages",
  };
  const prefCol = prefMap[input.type];
  let pushAllowed = true;
  if (prefCol) {
    try {
      const { rows: pRows } = await dbQuery<Record<string, boolean>>(
        `SELECT ${prefCol} AS allowed FROM notification_preferences WHERE user_id = $1`,
        [recipientUserId],
      );
      if (pRows[0] && pRows[0].allowed === false) pushAllowed = false;
    } catch { /* table missing or query error → fall through */ }
  }

  if (pushAllowed && notificationId) {
    void sendPushToUser(recipientUserId, pushPayload).then(async () => {
      try {
        await dbQuery(
          `UPDATE notifications SET delivery_status = 'sent', updated_at = NOW() WHERE id = $1`,
          [notificationId],
        );
      } catch (e) {
        logger.warn({ err: e }, "[notifyUser] mark sent failed");
      }
    }).catch(async (err) => {
      logger.warn({ err }, "[notifyUser] push failed");
      try {
        await dbQuery(
          `UPDATE notifications SET delivery_status = 'failed', updated_at = NOW() WHERE id = $1`,
          [notificationId],
        );
      } catch (e) {
        logger.warn({ err: e }, "[notifyUser] mark failed failed");
      }
    });
  } else if (notificationId && !pushAllowed) {
    void dbQuery(
      `UPDATE notifications SET delivery_status = 'suppressed', updated_at = NOW() WHERE id = $1`,
      [notificationId],
    ).catch((e) => logger.warn({ err: e }, "[notifyUser] mark suppressed failed"));
  }
}

/**
 * Fan-out "new_post" catre followers unui creator (batch, best-effort).
 * Limitat la cei mai recenti `maxFollowers` ca sa nu blocheze requestul.
 */
export async function notifyFollowersNewPost(
  creatorUserId: string,
  videoId: string,
  opts?: { title?: string; maxFollowers?: number },
): Promise<number> {
  const limit = Math.min(Math.max(opts?.maxFollowers ?? 500, 1), 5000);
  const { rows } = await dbQuery<{ follower_user_id: string }>(
    `SELECT follower_user_id FROM follows
      WHERE following_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [creatorUserId, limit],
  );
  let sent = 0;
  for (const r of rows) {
    try {
      await notifyUser(r.follower_user_id, {
        type: "new_post",
        actorUserId: creatorUserId,
        targetType: "video",
        targetId: videoId,
        payload: {
          title: opts?.title || TITLES.new_post,
          url: `/explore?v=${videoId}`,
        },
      });
      sent++;
    } catch (e) {
      logger.warn({ err: e }, "[notifyFollowersNewPost] failed");
    }
  }
  return sent;
}
