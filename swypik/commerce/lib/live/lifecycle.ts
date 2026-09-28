/**
 * Ciclul de viață al unui stream, într-un singur loc (audit live §6.3):
 *   scheduled ──(media confirmată: heartbeat gazdă + track activ în SFU-ul Cloudflare)──▶ live ──▶ ended
 * Un stream devine 'live' DOAR când SFU-ul confirmă publicarea (w1-security);
 * un stream încheiat nu mai poate reveni. Tranzițiile: lib/live/access.ts
 * (decideTransition), orchestrarea: lib/live/media.ts + lib/live/sweep.ts.
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { routing } from "@/lib/i18n/routing";
import { logger } from "@/lib/logger";
import { sendPushToUser } from "@/lib/push/web-push";
import { LIVE_CONFIG } from "./config";

/** Prin id (+ creator, când vine de la gazdă). */
export type StreamRef = { streamId: string; creatorId?: string };

export type WentLive = { id: string; creator_id: string; title: string; prev_status: string };

function whereFor(ref: StreamRef): { sql: string; params: string[] } {
  return ref.creatorId
    ? { sql: "id = $1::uuid AND creator_id = $2", params: [ref.streamId, ref.creatorId] }
    : { sql: "id = $1::uuid", params: [ref.streamId] };
}

/**
 * scheduled|live → live. Întoarce streamul (cu statusul anterior) sau null dacă
 * nu există / e încheiat. La prima trecere în live notifică followerii.
 */
export async function markStreamLive(ref: StreamRef): Promise<WentLive | null> {
  const where = whereFor(ref);
  const { rows } = await dbQuery<WentLive>(
    `WITH prev AS (
       SELECT id, status AS prev_status FROM live_streams
        WHERE ${where.sql} AND status IN ('scheduled', 'live')
        FOR UPDATE
     )
     UPDATE live_streams ls SET status = 'live', started_at = COALESCE(ls.started_at, now())
       FROM prev WHERE ls.id = prev.id
     RETURNING ls.id, ls.creator_id, ls.title, prev.prev_status`,
    where.params,
  );
  const stream = rows[0] ?? null;
  // Reconectare encoder/gazdă (deja live): fără notificări duplicate.
  if (stream && stream.prev_status !== "live") await notifyFollowersLive(stream);
  return stream;
}

/**
 * live → ended (sau orice stare ne-încheiată, când `includeScheduled`, ex. gazda
 * anulează). Întoarce true dacă s-a schimbat ceva.
 */
export async function markStreamEnded(ref: StreamRef, opts: { includeScheduled?: boolean } = {}): Promise<boolean> {
  const where = whereFor(ref);
  const statuses = opts.includeScheduled ? "('live', 'scheduled')" : "('live')";
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE live_streams SET status = 'ended', ended_at = now(), viewer_count = 0
      WHERE ${where.sql} AND status IN ${statuses}
      RETURNING id`,
    where.params,
  );
  return rows.length > 0;
}

/** Numărul curent de spectatori (din heartbeat-urile din Redis) + vârful. */
export async function updateViewerCount(streamId: string, viewers: number): Promise<void> {
  const n = Math.max(0, Math.trunc(viewers));
  await dbQuery(
    `UPDATE live_streams SET viewer_count = $2, peak_viewers = GREATEST(peak_viewers, $2)
      WHERE id = $1::uuid AND status = 'live'`,
    [streamId, n],
  );
}

async function titlesByLocale(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const locale of routing.locales) {
    const t = await getTranslations({ locale, namespace: "live.notify" });
    out[locale] = t("title");
  }
  return out;
}

/**
 * O singură inserare pentru toți followerii (titlu în limba fiecăruia), apoi
 * push plafonat, fără să blocheze apelantul (înainte: INSERT + push secvențial
 * per follower în hook).
 */
export async function notifyFollowersLive(stream: WentLive): Promise<void> {
  try {
    // Fără traduceri (ex. context non-Next) cădem pe titlul streamului.
    const titles = await titlesByLocale().catch((): Record<string, string> => ({}));
    const url = `/live/${stream.id}`;
    const { rows } = await dbQuery<{ follower_user_id: string; title?: string }>(
      `INSERT INTO notifications (user_id, actor_user_id, notification_type, title, body, action_url, metadata)
       SELECT f.follower_user_id, $1::uuid, 'creator_live',
              COALESCE($2::jsonb ->> COALESCE(u.locale, $6), $2::jsonb ->> $6, $3),
              $3, $4, $5::jsonb
         FROM follows f
         JOIN users u ON u.id = f.follower_user_id
        WHERE f.following_user_id::text = $1
          AND f.notification_level <> 'none'
       RETURNING user_id AS follower_user_id, title`,
      [stream.creator_id, JSON.stringify(titles), stream.title, url, JSON.stringify({ stream_id: stream.id }), routing.defaultLocale],
    );
    const fallback = titles[routing.defaultLocale] ?? stream.title;
    void Promise.allSettled(
      rows.slice(0, LIVE_CONFIG.notifyPushMax).map((r) =>
        sendPushToUser(r.follower_user_id, { title: r.title || fallback, body: stream.title, url }),
      ),
    );
  } catch (err) {
    logger.warn({ err, streamId: stream.id }, "[live] notify followers failed");
  }
}
