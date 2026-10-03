/**
 * Notificarea pentru un mesaj DM nou: tradusă în limba destinatarului,
 * link spre `/messages/<id>` și COALESCATĂ — cel mult o notificare necitită
 * per conversație (mesajele următoare o actualizează în loc să inunde lista).
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyUser } from "@/lib/notifications/dispatch";
import { userLocale } from "@/lib/notifications/localized";
import { DM_CONFIG } from "./config";
import { conversationPath } from "./links";

export type DmNotifyInput = {
  recipientId: string;
  senderId: string;
  conversationId: string;
  body: string;
  hasMedia: boolean;
};

async function senderName(senderId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ display_name: string | null; username: string | null }>(
    `SELECT display_name, username FROM users WHERE id = $1`,
    [senderId],
  );
  return rows[0]?.display_name || (rows[0]?.username ? `@${rows[0].username}` : null);
}

/** Best-effort: o notificare eșuată nu blochează trimiterea mesajului. */
export async function notifyNewDirectMessage(input: DmNotifyInput): Promise<void> {
  const { recipientId, senderId, conversationId } = input;
  if (!recipientId || recipientId === senderId) return;
  try {
    const [locale, name] = await Promise.all([userLocale(recipientId), senderName(senderId)]);
    const t = await getTranslations({ locale, namespace: "dm.notify" });
    const title = name ? t("title", { name }) : t("titleAnonymous");
    const preview = input.body.trim().slice(0, DM_CONFIG.notifyPreviewChars);
    const body = preview || (input.hasMedia ? t("photo") : "");
    const url = conversationPath(conversationId);

    const updated = await dbQuery<{ id: string }>(
      `UPDATE notifications
          SET title = $3, body = $4, actor_user_id = $5, action_url = $6,
              created_at = NOW(), updated_at = NOW(),
              metadata = metadata || jsonb_build_object('count', COALESCE((metadata->>'count')::int, 1) + 1)
        WHERE user_id = $1 AND notification_type = 'message' AND read_at IS NULL
          AND metadata->>'conversation_id' = $2
        RETURNING id`,
      [recipientId, conversationId, title, body, senderId, url],
    );
    if (updated.rows.length > 0) return;

    await notifyUser(recipientId, {
      type: "message",
      actorUserId: senderId,
      payload: { title, body, url, conversation_id: conversationId, count: 1 },
    });
  } catch (err) {
    logger.warn({ err, conversationId }, "[dm] notify peer failed");
  }
}
