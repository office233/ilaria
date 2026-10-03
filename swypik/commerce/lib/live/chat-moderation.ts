/**
 * Moderarea chatului Live (UGC): filtru automat + raport + acțiunile gazdei.
 *
 *   screenLiveChatMessage — Azure AI Content Safety (lib/ai/moderate.ts) înainte
 *     de publicare. Chatul e în timp real, deci nu există „în așteptare”: un mesaj
 *     marcat (review/block) e refuzat; dacă serviciul e indisponibil refuzăm tot
 *     (fail-closed). Neconfigurat → trece (euristica rămâne rate-limit + raport).
 *   hideLiveChatMessage / banLiveChatAuthor — gazda streamului sau un admin;
 *     clienții primesc `event: remove` prin SSE.
 *   reportLiveChatMessage — orice utilizator autentificat → moderation_reports.
 *
 * Nimic din acestea nu expune user_id-ul autorului către client.
 */
import { dbQuery } from "@/lib/db";
import { moderate } from "@/lib/ai/moderate";
import { publishRealtime, realtimeChannels } from "@/lib/realtime";
import { logger } from "@/lib/logger";

export type ScreenResult = { ok: true } | { ok: false; code: "message_blocked" | "moderation_unavailable" };

export async function screenLiveChatMessage(message: string): Promise<ScreenResult> {
  const verdict = await moderate(message, "live_chat");
  if (verdict.decision === "unavailable") return { ok: false, code: "moderation_unavailable" };
  if (verdict.flagged) {
    logger.info({ reasons: verdict.reasons }, "live.chat.blocked");
    return { ok: false, code: "message_blocked" };
  }
  return { ok: true };
}

export async function isBannedFromChat(streamId: string, userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ banned: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM live_chat_bans WHERE stream_id = $1 AND user_id = $2) AS banned`,
    [streamId, userId],
  );
  return Boolean(rows[0]?.banned);
}

type Actor = { userId: string; role: string | null };

async function canModerate(streamId: string, actor: Actor): Promise<boolean> {
  if (actor.role === "admin") return true;
  const { rows } = await dbQuery<{ creator_id: string }>(
    `SELECT COALESCE(creator_user_id::text, creator_id) AS creator_id
       FROM live_streams WHERE id = $1`,
    [streamId],
  );
  return rows[0]?.creator_id === actor.userId;
}

async function messageAuthor(streamId: string, messageId: number): Promise<{ userId: string; message: string } | null> {
  const { rows } = await dbQuery<{ user_id: string; message: string }>(
    `SELECT user_id, message FROM live_chat_messages WHERE id = $1 AND stream_id = $2`,
    [messageId, streamId],
  );
  return rows[0] ? { userId: rows[0].user_id, message: rows[0].message } : null;
}

export type ModerateActionResult = { ok: true; removedIds: number[] } | { ok: false; code: "forbidden" | "not_found" | "cannot_ban_self" };

export async function hideLiveChatMessage(streamId: string, messageId: number, actor: Actor): Promise<ModerateActionResult> {
  if (!(await canModerate(streamId, actor))) return { ok: false, code: "forbidden" };
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE live_chat_messages SET hidden_at = now(), hidden_by = $3
      WHERE id = $1 AND stream_id = $2 AND hidden_at IS NULL RETURNING id::text`,
    [messageId, streamId, actor.userId],
  );
  if (!rows[0]) return { ok: false, code: "not_found" };
  const removedIds = [Number(rows[0].id)];
  await publishRealtime(realtimeChannels.liveChat(streamId), { removedIds });
  return { ok: true, removedIds };
}

/** Blochează autorul mesajului pe acest stream și îi ascunde toate mesajele. */
export async function banLiveChatAuthor(streamId: string, messageId: number, actor: Actor): Promise<ModerateActionResult> {
  if (!(await canModerate(streamId, actor))) return { ok: false, code: "forbidden" };
  const author = await messageAuthor(streamId, messageId);
  if (!author) return { ok: false, code: "not_found" };
  if (author.userId === actor.userId) return { ok: false, code: "cannot_ban_self" };
  await dbQuery(
    `INSERT INTO live_chat_bans (stream_id, user_id, banned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [streamId, author.userId, actor.userId],
  );
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE live_chat_messages SET hidden_at = now(), hidden_by = $3
      WHERE stream_id = $1 AND user_id = $2 AND hidden_at IS NULL RETURNING id::text`,
    [streamId, author.userId, actor.userId],
  );
  const removedIds = rows.map((r) => Number(r.id));
  if (removedIds.length) await publishRealtime(realtimeChannels.liveChat(streamId), { removedIds });
  logger.info({ streamId, by: actor.userId, hidden: removedIds.length }, "live.chat.author_banned");
  return { ok: true, removedIds };
}

export const LIVE_CHAT_REPORT_REASONS = ["spam", "harassment", "hate", "violence", "sexual_content", "scam", "other"] as const;
export type LiveChatReportReason = (typeof LIVE_CHAT_REPORT_REASONS)[number];

export type ReportResult = { ok: true } | { ok: false; code: "not_found" | "cannot_report_self" };

/** Raport → moderation_reports (țintă = autorul; mesajul și streamul în metadata). Idempotent per reporter+autor deschis. */
export async function reportLiveChatMessage(
  streamId: string,
  messageId: number,
  reporterId: string,
  reason: LiveChatReportReason,
): Promise<ReportResult> {
  const author = await messageAuthor(streamId, messageId);
  if (!author) return { ok: false, code: "not_found" };
  if (author.userId === reporterId) return { ok: false, code: "cannot_report_self" };
  await dbQuery(
    `INSERT INTO moderation_reports (reporter_user_id, target_user_id, reason, metadata)
     SELECT $1::uuid, u.id, $3, $4::jsonb FROM users u WHERE u.id::text = $2
     ON CONFLICT DO NOTHING`,
    [reporterId, author.userId, reason, JSON.stringify({ kind: "live_chat", stream_id: streamId, message_id: messageId, message: author.message.slice(0, 500) })],
  );
  return { ok: true };
}
