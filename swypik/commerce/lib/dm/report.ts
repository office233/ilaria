/** Raportarea unui utilizator/mesaj din chat (moderation_reports, migrarea 0081). */
import { dbQuery } from "@/lib/db";
import type { DmReportReason } from "./config";
import { getPeerUserId, requireParticipant } from "./repository";
import { statusError } from "./types";

export type DmReportInput = {
  reason: DmReportReason;
  messageId?: string | null;
  note?: string | null;
};

/**
 * Ținta raportului e interlocutorul; mesajul (doar dacă e al lui, din aceeași
 * conversație) e atașat ca context. Întoarce id-ul raportului.
 */
export async function reportConversation(
  reporterId: string,
  conversationId: string,
  input: DmReportInput,
): Promise<string> {
  await requireParticipant(conversationId, reporterId);
  const peerId = await getPeerUserId(conversationId, reporterId);
  if (!peerId) throw statusError("No peer", 404, "peer_not_found");

  let messageId: string | null = null;
  if (input.messageId) {
    const { rows } = await dbQuery(
      `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND sender_id = $3`,
      [input.messageId, conversationId, peerId],
    );
    messageId = rows.length ? input.messageId : null;
  }

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO moderation_reports (reporter_user_id, target_user_id, target_message_id, reason, note, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      reporterId,
      peerId,
      messageId,
      input.reason,
      input.note ?? null,
      JSON.stringify({ source: "dm", conversation_id: conversationId }),
    ],
  );
  return rows[0].id;
}
