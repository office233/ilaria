/**
 * Chatul live: scriere + fan-out realtime între replici.
 *
 * Înainte: fiecare client SSE interoga Postgres la 1,5 s (`id > lastId`) —
 * corect între replici, dar O(clienți) interogări/secundă: 10k spectatori =
 * ~6.700 SELECT/s. Acum: POST-ul inserează în DB (sursa de adevăr) și publică
 * mesajul pe `live:chat:<streamId>`; fiecare replică îl primește o singură dată
 * prin hub și îl împarte clienților locali. DB-ul se citește doar la
 * conectare (catch-up după `Last-Event-ID`) și într-o plasă de siguranță rară
 * (`LIVE_CHAT_FALLBACK_POLL_MS`, implicit 15 s) pentru mesajele pierdute cât
 * Redis a fost indisponibil.
 *
 * Confidențialitate: payload-ul public NU conține user_id (doar nume afișat,
 * username, avatar). Moderarea (ascundere/blocare/raport) lucrează pe id-ul
 * mesajului; serverul găsește autorul (lib/live/chat-moderation.ts).
 */
import { dbQuery } from "@/lib/db";
import { getRealtimeHub, publishRealtime, realtimeChannels } from "@/lib/realtime";
import { createSseResponse, type SseSend } from "@/lib/realtime/sse";
import { liveChannel } from "@/lib/live/events";

export type ChatRow = {
  /** BIGSERIAL — `pg` îl întoarce ca string; normalizăm cu `Number()`. */
  id: number | string;
  message: string;
  created_at: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

/** Mesaj retras (ascuns de gazdă / autor blocat) — publicat pe același canal. */
export type ChatRemoval = { removedIds: Array<number | string> };

// Numele autorului (înainte chatul afișa literal „user” — audit live §2.8), fără user_id.
const CHAT_COLUMNS = "m.id, m.message, m.created_at, u.username, u.display_name, u.avatar_url";
const CATCH_UP_LIMIT = 100;
const SEEN_WINDOW = 1000;

function fallbackPollMs(): number {
  const n = Number(process.env.LIVE_CHAT_FALLBACK_POLL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 15_000;
}

/** Inserează mesajul (doar pe un stream live) și îl publică tuturor replicilor. */
export async function postLiveChatMessage(streamId: string, userId: string, message: string): Promise<ChatRow | null> {
  const { rows } = await dbQuery<ChatRow>(
    `WITH ins AS (
       INSERT INTO live_chat_messages (stream_id, user_id, message)
       SELECT id, $2, $3 FROM live_streams
        WHERE id = $1 AND status = 'live'
          AND NOT EXISTS (SELECT 1 FROM live_chat_bans b WHERE b.stream_id = $1 AND b.user_id = $2)
       RETURNING id, user_id, message, created_at
     )
     SELECT ${CHAT_COLUMNS} FROM ins m LEFT JOIN users u ON u.id::text = m.user_id`,
    [streamId, userId, message],
  );
  const row = rows[0];
  if (!row) return null;
  await publishRealtime(realtimeChannels.liveChat(streamId), row);
  return row;
}

export async function listRecentChat(streamId: string, limit: number): Promise<ChatRow[]> {
  const { rows } = await dbQuery<ChatRow>(
    `SELECT ${CHAT_COLUMNS} FROM live_chat_messages m
       LEFT JOIN users u ON u.id::text = m.user_id
      WHERE m.stream_id = $1 AND m.hidden_at IS NULL ORDER BY m.id DESC LIMIT $2`,
    [streamId, limit],
  );
  return rows.reverse();
}

async function chatSince(streamId: string, lastId: number): Promise<ChatRow[]> {
  const { rows } = await dbQuery<ChatRow>(
    `SELECT ${CHAT_COLUMNS} FROM live_chat_messages m
       LEFT JOIN users u ON u.id::text = m.user_id
      WHERE m.stream_id = $1 AND m.id > $2 AND m.hidden_at IS NULL ORDER BY m.id ASC LIMIT ${CATCH_UP_LIMIT}`,
    [streamId, lastId],
  );
  return rows;
}

export function parseLastEventId(raw: string | null): number {
  const n = raw ? Number(raw) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * SSE: abonare întâi, apoi catch-up din DB. Dedup pe `id` (set mărginit), nu
 * pe „id > ultimul”: două replici pot publica aproape simultan, iar mesajul cu
 * id mai mic poate sosi al doilea — trebuie livrat, nu aruncat.
 */
export function liveChatSseResponse(streamId: string, lastEventId: number, signal: AbortSignal): Response {
  let lastId = lastEventId;
  const seen = new Set<number>();
  const emit = (send: SseSend, row: ChatRow) => {
    const id = Number(row?.id);
    if (!Number.isSafeInteger(id) || id <= lastEventId || seen.has(id)) return;
    seen.add(id);
    if (seen.size > SEEN_WINDOW) seen.delete(seen.values().next().value as number);
    if (id > lastId) lastId = id;
    send(row, { id, event: "chat" });
  };
  const catchUp = async (send: SseSend) => {
    for (const row of await chatSince(streamId, lastId)) emit(send, row);
  };

  return createSseResponse({
    logTag: "live/chat",
    // Chatul + starea streamului (live/ended, spectatori — lib/live/lifecycle.ts) pe același hub.
    channels: [realtimeChannels.liveChat(streamId), liveChannel(streamId)],
    signal,
    onMessage: (channel, raw, send) => {
      try {
        if (channel === liveChannel(streamId)) {
          send(JSON.parse(raw), { event: "state" });
          return;
        }
        const payload = JSON.parse(raw) as ChatRow | ChatRemoval;
        if ("removedIds" in payload) {
          send({ ids: payload.removedIds.map(Number) }, { event: "remove" });
          return;
        }
        emit(send, payload);
      } catch {
        /* payload invalid — ignorat */
      }
    },
    onOpen: catchUp,
    // Plasa de siguranță citește DB-ul doar cât abonarea Redis NU e sănătoasă.
    poll: {
      intervalMs: fallbackPollMs(),
      run: async (send) => {
        if (getRealtimeHub().healthy()) return;
        await catchUp(send);
      },
    },
  });
}
