/** Tipuri partajate server/client pentru Messenger (DM). */

export type DmPeer = {
  user_id: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type ConversationRow = {
  id: string;
  kind: "dm" | "group";
  created_by: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  media_url: string | null;
  reply_to_message_id: string | null;
  status: "sent" | "edited" | "deleted";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConversationSummary = {
  id: string;
  kind: "dm" | "group";
  last_message_at: string | null;
  created_at: string;
  peer: DmPeer | null;
  last_message: {
    id: string;
    sender_id: string;
    body: string;
    has_media: boolean;
    created_at: string;
  } | null;
  unread_count: number;
};

/** Detaliile unei conversații pentru ecranul de chat (header + confirmări de citire). */
export type ConversationDetail = {
  id: string;
  peer: DmPeer | null;
  /** Momentul până la care interlocutorul a citit (pentru „Văzut”). */
  peer_last_read_at: string | null;
  /** Eu l-am blocat pe interlocutor. */
  blocked_by_me: boolean;
  /** Interlocutorul m-a blocat (nu îi pot scrie). */
  blocked_me: boolean;
};

export type MessageWithSender = MessageRow & {
  sender: {
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
};

/** Evenimente publicate pe canalul Redis `dm:conv:<id>` și trimise prin SSE. */
export type DmStreamEvent =
  | { type: "message"; message: MessageRow }
  | { type: "read"; user_id: string; last_read_at: string }
  | { type: "typing"; user_id: string };

/** Eroare 4xx aruncată de modulele DM (ex. `{ status: 403 }`). */
export type StatusError = Error & { status?: number; code?: string };

export function isStatusError(err: unknown): err is StatusError {
  return err instanceof Error && typeof (err as StatusError).status === "number";
}

export function statusError(message: string, status: number, code?: string): StatusError {
  return Object.assign(new Error(message), { status, code });
}
