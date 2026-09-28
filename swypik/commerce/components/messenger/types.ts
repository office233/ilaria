import type { ConversationDetail, ConversationSummary, DmPeer } from "@/lib/dm/types";

export type { ConversationDetail, ConversationSummary, DmPeer };

/** Mesaj în starea clientului (include bulele optimiste). */
export type ChatMessage = {
  id: string;
  sender_id: string;
  body: string;
  media_url: string | null;
  created_at: string;
  /** Trimis local, încă neconfirmat de server. */
  pending?: boolean;
  /** Trimiterea a eșuat — se poate reîncerca. */
  failed?: boolean;
  /** Fișierul local pentru reîncercarea unei imagini. */
  file?: File | null;
};

export function peerName(peer: DmPeer | null | undefined, fallback: string): string {
  return peer?.display_name || (peer?.username ? `@${peer.username}` : fallback);
}

export function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** Ultimul mesaj propriu (confirmat) văzut de interlocutor — acolo apare „Văzut”. */
export function lastSeenOwnMessageId(
  messages: readonly ChatMessage[],
  viewerId: string,
  peerLastReadAt: string | null,
): string | null {
  if (!peerLastReadAt) return null;
  const readAt = new Date(peerLastReadAt).getTime();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender_id !== viewerId || m.pending || m.failed) continue;
    if (new Date(m.created_at).getTime() <= readAt) return m.id;
  }
  return null;
}
