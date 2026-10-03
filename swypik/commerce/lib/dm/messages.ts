/** DM — mesaje: listare paginată, trimitere, confirmări de citire, „scrie…”. */
import { dbQuery } from "@/lib/db";
import { isBlockedEitherWay } from "./blocks";
import { DM_CONFIG } from "./config";
import { getPeerUserId, publishDmEvent, requireParticipant } from "./repository";
import { statusError, type MessageRow, type MessageWithSender } from "./types";

const MESSAGE_COLUMNS = `id, conversation_id, sender_id, body, media_url, reply_to_message_id,
                         status, metadata, created_at, updated_at`;

export async function listMessages(
  conversationId: string,
  viewerId: string,
  opts: { limit?: number; beforeCursor?: string | null } = {},
): Promise<MessageWithSender[]> {
  await requireParticipant(conversationId, viewerId);
  const limit = Math.min(Math.max(opts.limit ?? DM_CONFIG.pageSize, 1), 100);
  const before = opts.beforeCursor || null;

  const { rows } = await dbQuery<
    MessageRow & { sender_username: string | null; sender_display_name: string | null; sender_avatar_url: string | null }
  >(
    `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.media_url,
            m.reply_to_message_id, m.status, m.metadata, m.created_at, m.updated_at,
            u.username AS sender_username,
            u.display_name AS sender_display_name,
            COALESCE(cpr.avatar_url, u.avatar_url) AS sender_avatar_url
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
      WHERE m.conversation_id = $1
        AND m.status <> 'deleted'
        AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [conversationId, before, limit],
  );

  return rows
    .map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      sender_id: r.sender_id,
      body: r.body,
      media_url: r.media_url,
      reply_to_message_id: r.reply_to_message_id,
      status: r.status,
      metadata: r.metadata || {},
      created_at: r.created_at,
      updated_at: r.updated_at,
      sender: {
        id: r.sender_id,
        username: r.sender_username,
        display_name: r.sender_display_name,
        avatar_url: r.sender_avatar_url,
      },
    }))
    .reverse(); // cronologic pentru client
}

export type SendMessageInput = {
  body: string;
  /** Doar din ruta de atașamente (URL-ul propriului storage), niciodată din client. */
  mediaUrl?: string | null;
  replyToMessageId?: string | null;
};

/**
 * Trimite un mesaj. 400 dacă e gol/prea lung, 403 dacă expeditorul nu e
 * participant sau dacă există o blocare în oricare sens (`code: blocked`).
 */
export async function sendMessage(
  senderId: string,
  conversationId: string,
  data: SendMessageInput,
): Promise<MessageRow> {
  const body = (data.body || "").trim();
  const mediaUrl = data.mediaUrl || null;
  if ((!body && !mediaUrl) || body.length > DM_CONFIG.maxBody) {
    throw statusError("Invalid message body", 400, "invalid_body");
  }
  await requireParticipant(conversationId, senderId);

  const peerId = await getPeerUserId(conversationId, senderId);
  if (peerId && (await isBlockedEitherWay(senderId, peerId))) {
    throw statusError("Blocked", 403, "blocked");
  }

  // Răspunsul trebuie să citeze un mesaj din aceeași conversație.
  let replyTo: string | null = null;
  if (data.replyToMessageId) {
    const { rows } = await dbQuery(`SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2`, [
      data.replyToMessageId,
      conversationId,
    ]);
    replyTo = rows.length ? data.replyToMessageId : null;
  }

  const { rows } = await dbQuery<MessageRow>(
    `INSERT INTO messages (conversation_id, sender_id, body, media_url, reply_to_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${MESSAGE_COLUMNS}`,
    [conversationId, senderId, body, mediaUrl, replyTo],
  );
  const message = rows[0];

  // Expeditorul și-a citit propriul mesaj: nu apare ca necitit la el.
  await dbQuery(
    `UPDATE conversations SET last_message_at = $2, updated_at = NOW() WHERE id = $1`,
    [conversationId, message.created_at],
  );
  await dbQuery(
    `UPDATE conversation_participants SET last_read_at = $3
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, senderId, message.created_at],
  );

  await publishDmEvent(conversationId, { type: "message", message });
  return message;
}

/** Marchează conversația citită și anunță interlocutorul (confirmare „Văzut”). */
export async function markRead(
  conversationId: string,
  viewerId: string,
): Promise<{ last_read_at: string } | null> {
  await requireParticipant(conversationId, viewerId);
  const { rows } = await dbQuery<{ last_read_at: string }>(
    `UPDATE conversation_participants
        SET last_read_at = NOW()
      WHERE conversation_id = $1 AND user_id = $2
      RETURNING last_read_at`,
    [conversationId, viewerId],
  );
  const row = rows[0] ?? null;
  if (row) {
    // Notificarea DM coalescată pentru conversație devine citită.
    await dbQuery(
      `UPDATE notifications SET read_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND notification_type = 'message' AND read_at IS NULL
          AND metadata->>'conversation_id' = $2`,
      [viewerId, conversationId],
    );
    await publishDmEvent(conversationId, { type: "read", user_id: viewerId, last_read_at: String(row.last_read_at) });
  }
  return row;
}

/** Semnal efemer „scrie…” (doar Redis, nimic în DB). */
export async function publishTyping(conversationId: string, userId: string): Promise<void> {
  await requireParticipant(conversationId, userId);
  await publishDmEvent(conversationId, { type: "typing", user_id: userId });
}
