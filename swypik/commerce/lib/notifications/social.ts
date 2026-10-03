/**
 * Notificări sociale (follow, like, comentariu, răspuns, mențiune) — o singură
 * cale, cu regulile audit-ului profiles-social + valul de securitate:
 *  - niciodată de la un vizitator anonim și niciodată către sine;
 *  - niciodată între doi utilizatori care se blochează (în orice sens);
 *  - titlul e tradus în limba destinatarului, cu numele actorului;
 *  - linkul e canonic (/u/<username>, /explore?v=<id>&comment=<id>);
 *  - like-urile repetate (like/unlike/like) nu notifică de două ori în 24h.
 * Best-effort: o notificare eșuată nu blochează acțiunea care a declanșat-o.
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isBlockedEitherWay } from "@/lib/social/blocks";
import { profilePath, videoPath } from "@/lib/social/links";
import { notifyUser, type NotificationType } from "./dispatch";
import { userLocale } from "./localized";

export type SocialNotice = "follow" | "videoLike" | "commentLike" | "comment" | "reply" | "mention";

export type SocialActor = { userId: string; isAnon: boolean };

export type SocialNotifyInput = {
  recipientId: string | null | undefined;
  actor: SocialActor;
  notice: SocialNotice;
  videoId?: string | null;
  commentId?: string | null;
  /** Textul comentariului (trunchiat) pentru comment/reply/mention. */
  preview?: string | null;
};

const TYPE_OF: Record<SocialNotice, NotificationType> = {
  follow: "follow",
  videoLike: "like",
  commentLike: "like",
  comment: "comment",
  reply: "reply",
  mention: "mention",
};

const PREVIEW_MAX = 120;
const DEDUPED: ReadonlySet<SocialNotice> = new Set(["follow", "videoLike", "commentLike"]);

/** Regulile de eligibilitate, separate ca să fie testabile. */
export function shouldNotify(input: Pick<SocialNotifyInput, "recipientId" | "actor">): boolean {
  return Boolean(input.recipientId) && !input.actor.isAnon && input.recipientId !== input.actor.userId;
}

async function alreadyNotified(input: SocialNotifyInput, type: NotificationType): Promise<boolean> {
  const { rows } = await dbQuery<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM notifications
        WHERE user_id = $1 AND actor_user_id = $2 AND notification_type = $3
          AND video_id IS NOT DISTINCT FROM $4::uuid
          AND comment_id IS NOT DISTINCT FROM $5::uuid
          AND created_at > now() - interval '24 hours'
     ) AS found`,
    // notifyUser păstrează fie comment_id, fie video_id (vezi targetType mai jos).
    [
      input.recipientId,
      input.actor.userId,
      type,
      input.commentId ? null : input.videoId ?? null,
      input.commentId ?? null,
    ],
  );
  return Boolean(rows[0]?.found);
}

export async function notifySocial(input: SocialNotifyInput): Promise<void> {
  if (!shouldNotify(input)) return;
  const recipientId = input.recipientId as string;
  try {
    if (await isBlockedEitherWay(recipientId, input.actor.userId)) return;
    const type = TYPE_OF[input.notice];
    if (DEDUPED.has(input.notice) && (await alreadyNotified(input, type))) return;

    const { rows } = await dbQuery<{ username: string; display_name: string | null }>(
      `SELECT username, display_name FROM users WHERE id = $1`,
      [input.actor.userId],
    );
    const actor = rows[0];
    if (!actor) return;

    const locale = await userLocale(recipientId);
    const t = await getTranslations({ locale, namespace: "notificationsText.social" });
    const name = actor.display_name?.trim() || `@${actor.username}`;
    const url =
      input.notice === "follow" || !input.videoId
        ? profilePath(actor.username)
        : videoPath(input.videoId, input.commentId);

    await notifyUser(recipientId, {
      type,
      actorUserId: input.actor.userId,
      targetType: input.commentId ? "comment" : input.videoId ? "video" : null,
      targetId: input.commentId ?? input.videoId ?? null,
      payload: {
        notice: input.notice,
        title: t(`${input.notice}.title`, { name }),
        body: (input.preview ?? "").slice(0, PREVIEW_MAX),
        url,
        actorUsername: actor.username,
        videoId: input.videoId ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, notice: input.notice }, "notifications.social.failed");
  }
}
