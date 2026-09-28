/**
 * DM repository — conversații și participanți. Mesajele sunt în ./messages
 * (re-exportate aici ca rutele să aibă un singur punct de import).
 *
 * Auth: apelanții trimit un userId real (getAccountUserId pentru scrieri);
 * toate funcțiile verifică apartenența la conversație.
 */
import { dbQuery } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { getBlockState } from "./blocks";
import { dmChannel, dmPairKey } from "./config";
import {
  isStatusError,
  statusError,
  type ConversationDetail,
  type ConversationSummary,
  type DmStreamEvent,
} from "./types";

export type {
  ConversationRow,
  ConversationSummary,
  ConversationDetail,
  MessageRow,
  MessageWithSender,
  StatusError,
} from "./types";
export { isStatusError };

export async function assertParticipant(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await dbQuery(
    `SELECT 1 FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

export async function requireParticipant(conversationId: string, userId: string): Promise<void> {
  if (!(await assertParticipant(conversationId, userId))) {
    throw statusError("Not a participant", 403, "forbidden");
  }
}

/** Publică un eveniment pe canalul conversației (best-effort; SSE îl preia). */
export async function publishDmEvent(conversationId: string, event: DmStreamEvent): Promise<void> {
  try {
    await getRedis().publish(dmChannel(conversationId), JSON.stringify(event));
  } catch (err: unknown) {
    logger.warn({ err, conversationId, type: event.type }, "[dm] redis publish failed");
  }
}

/**
 * Găsește sau creează DM-ul unic dintre doi utilizatori. Cheia `dm_key`
 * (index unic, migrarea 0082) face creările simultane idempotente.
 * Refuză (403 `blocked`) dacă oricare l-a blocat pe celălalt.
 */
export async function getOrCreateDmConversation(
  viewerId: string,
  peerId: string,
): Promise<{ conversationId: string; isNew: boolean }> {
  if (!viewerId || !peerId || viewerId === peerId) {
    throw statusError("Invalid DM participants", 400, "invalid_peer");
  }
  const block = await getBlockState(viewerId, peerId);
  if (block.blockedByMe || block.blockedMe) throw statusError("Blocked", 403, "blocked");

  const key = dmPairKey(viewerId, peerId);
  const { rows } = await dbQuery<{ id: string; is_new: boolean }>(
    `WITH ins AS (
        INSERT INTO conversations (kind, created_by, dm_key)
        VALUES ('dm', $1::uuid, $3)
        ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING
        RETURNING id
      ),
      parts AS (
        INSERT INTO conversation_participants (conversation_id, user_id)
        SELECT ins.id, u FROM ins, unnest(ARRAY[$1::uuid, $2::uuid]) AS u
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT id, true AS is_new FROM ins
      UNION ALL
      SELECT id, false AS is_new FROM conversations WHERE dm_key = $3
      LIMIT 1`,
    [viewerId, peerId, key],
  );
  const row = rows[0];
  if (!row) throw statusError("Peer not found", 404, "peer_not_found");
  return { conversationId: row.id, isNew: row.is_new };
}

/**
 * Conversațiile utilizatorului. O conversație fără mesaje apare doar la cel
 * care a deschis-o (interlocutorul n-o vede goală în listă).
 */
export async function listConversations(
  userId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const cursor = opts.cursor || null;

  const { rows } = await dbQuery<{
    id: string;
    kind: "dm" | "group";
    last_message_at: string | null;
    created_at: string;
    peer_id: string | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    last_message_id: string | null;
    last_sender_id: string | null;
    last_body: string | null;
    last_media_url: string | null;
    last_created_at: string | null;
    unread_count: number;
  }>(
    `SELECT c.id, c.kind, c.last_message_at, c.created_at,
            peer.id AS peer_id, peer.username, peer.display_name, peer.avatar_url,
            lm.id AS last_message_id, lm.sender_id AS last_sender_id, lm.body AS last_body,
            lm.media_url AS last_media_url, lm.created_at AS last_created_at,
            COALESCE(unread.n, 0)::int AS unread_count
       FROM conversation_participants me
       JOIN conversations c ON c.id = me.conversation_id
       LEFT JOIN LATERAL (
         SELECT u.id, u.username, u.display_name, COALESCE(cpr.avatar_url, u.avatar_url) AS avatar_url
           FROM conversation_participants p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
          WHERE p.conversation_id = c.id AND p.user_id <> $1
          LIMIT 1
       ) peer ON true
       LEFT JOIN LATERAL (
         SELECT m.id, m.sender_id, m.body, m.media_url, m.created_at
           FROM messages m
          WHERE m.conversation_id = c.id AND m.status <> 'deleted'
          ORDER BY m.created_at DESC
          LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.sender_id <> $1
            AND m2.status <> 'deleted'
            AND m2.created_at > COALESCE(me.last_read_at, '-infinity'::timestamptz)
       ) unread ON true
      WHERE me.user_id = $1
        AND (c.last_message_at IS NOT NULL OR c.created_by = $1)
        AND ($2::timestamptz IS NULL OR c.last_message_at < $2::timestamptz)
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $3`,
    [userId, cursor, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    last_message_at: r.last_message_at,
    created_at: r.created_at,
    peer: r.peer_id
      ? { user_id: r.peer_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url }
      : null,
    last_message: r.last_message_id
      ? {
          id: r.last_message_id,
          sender_id: String(r.last_sender_id),
          body: String(r.last_body ?? ""),
          has_media: Boolean(r.last_media_url),
          created_at: String(r.last_created_at),
        }
      : null,
    unread_count: Number(r.unread_count || 0),
  }));
}

/** Header-ul chatului: interlocutor, până unde a citit, stare de blocare. */
export async function getConversationDetail(
  conversationId: string,
  viewerId: string,
): Promise<ConversationDetail> {
  await requireParticipant(conversationId, viewerId);
  const { rows } = await dbQuery<{
    peer_id: string | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    peer_last_read_at: string | null;
  }>(
    `SELECT u.id AS peer_id, u.username, u.display_name,
            COALESCE(cpr.avatar_url, u.avatar_url) AS avatar_url,
            p.last_read_at AS peer_last_read_at
       FROM conversation_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN creator_profiles cpr ON cpr.user_id = u.id
      WHERE p.conversation_id = $1 AND p.user_id <> $2
      LIMIT 1`,
    [conversationId, viewerId],
  );
  const r = rows[0];
  const block = r?.peer_id ? await getBlockState(viewerId, r.peer_id) : { blockedByMe: false, blockedMe: false };
  return {
    id: conversationId,
    peer: r?.peer_id
      ? { user_id: r.peer_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url }
      : null,
    peer_last_read_at: r?.peer_last_read_at ?? null,
    blocked_by_me: block.blockedByMe,
    blocked_me: block.blockedMe,
  };
}

export async function getPeerUserId(conversationId: string, viewerId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ user_id: string }>(
    `SELECT user_id FROM conversation_participants
      WHERE conversation_id = $1 AND user_id <> $2
      LIMIT 1`,
    [conversationId, viewerId],
  );
  return rows[0]?.user_id ?? null;
}

export { listMessages, sendMessage, markRead, publishTyping } from "./messages";
