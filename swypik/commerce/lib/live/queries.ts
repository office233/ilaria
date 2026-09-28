/** Citiri Live partajate de pagini și API (înainte, SQL-ul era duplicat). */
import { dbQuery } from "@/lib/db";

export type LiveStatus = "scheduled" | "live" | "ended" | "failed";

export type LiveStreamPublic = {
  id: string;
  title: string;
  description: string | null;
  status: LiveStatus;
  provider: "rtmp" | "livekit" | "cf_sfu";
  viewer_count: number;
  peak_viewers: number;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Ultima publicare reușită a gazdei (se schimbă la reconectare → spectatorii retrag). */
  sfu_published_at: string | null;
  creator_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type LiveShopItem = {
  id: number;
  product_id: string;
  is_pinned: boolean;
  display_order: number;
  flash_price_cents: number | null;
  flash_until: string | null;
  title: string | null;
  image_url: string | null;
  price_cents: number | null;
  currency: string | null;
};

const STREAM_COLUMNS = `ls.id, ls.title, ls.description, ls.status, ls.provider, ls.viewer_count, ls.peak_viewers,
       ls.scheduled_at, ls.started_at, ls.ended_at, ls.sfu_published_at, ls.creator_id,
       u.username, u.display_name, u.avatar_url`;

/** Streamul fără secrete (stream_key / rtmp_url nu ies niciodată de aici). */
export async function getLiveStream(id: string): Promise<LiveStreamPublic | null> {
  const { rows } = await dbQuery<LiveStreamPublic>(
    `SELECT ${STREAM_COLUMNS}
       FROM live_streams ls
       LEFT JOIN users u ON u.id::text = ls.creator_id
      WHERE ls.id = $1::uuid
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export type LiveTrack = { trackName: string; mid: string };

/** Starea media a unui stream (doar server: sesiunea SFU a gazdei și track-urile ei). */
export type LiveMediaState = {
  id: string;
  status: LiveStatus;
  creator_id: string;
  sfu_session_id: string | null;
  sfu_tracks: LiveTrack[];
  sfu_published_at: string | null;
};

export async function getLiveMediaState(id: string): Promise<LiveMediaState | null> {
  const { rows } = await dbQuery<LiveMediaState>(
    `SELECT id, status, creator_id, sfu_session_id, sfu_tracks, sfu_published_at
       FROM live_streams WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, sfu_tracks: Array.isArray(row.sfu_tracks) ? row.sfu_tracks : [] };
}

export async function getLiveItems(streamId: string): Promise<LiveShopItem[]> {
  const { rows } = await dbQuery<LiveShopItem>(
    `SELECT lsi.id, lsi.product_id, lsi.is_pinned, lsi.display_order,
            lsi.flash_price_cents, lsi.flash_until,
            p.title, p.image_url, p.price_cents, p.currency
       FROM live_shop_items lsi
       LEFT JOIN marketplace_products p ON p.id::text = lsi.product_id
      WHERE lsi.stream_id = $1::uuid
      ORDER BY lsi.is_pinned DESC, lsi.display_order ASC, lsi.created_at ASC`,
    [streamId],
  );
  return rows;
}

/** Streamuri după status (grila /live, feed). */
export async function listLiveStreams(status: LiveStatus, limit: number, offset = 0): Promise<LiveStreamPublic[]> {
  const order = status === "scheduled" ? "ls.scheduled_at ASC NULLS LAST, ls.created_at DESC" : "ls.viewer_count DESC, ls.started_at DESC NULLS LAST";
  const { rows } = await dbQuery<LiveStreamPublic>(
    `SELECT ${STREAM_COLUMNS}
       FROM live_streams ls
       LEFT JOIN users u ON u.id::text = ls.creator_id
      WHERE ls.status = $1
      ORDER BY ${order}
      LIMIT $2${offset > 0 ? " OFFSET $3" : ""}`,
    offset > 0 ? [status, limit, offset] : [status, limit],
  );
  return rows;
}

/** Produsele pe care gazda le poate prezenta: cele din magazinul propriu (seller). */
export async function listHostProducts(userId: string, limit = 50): Promise<Array<{ id: string; title: string; image_url: string | null; price_cents: number | null; currency: string | null }>> {
  const { rows } = await dbQuery<{ id: string; title: string; image_url: string | null; price_cents: number | null; currency: string | null }>(
    `SELECT p.id::text AS id, p.title, p.image_url, p.price_cents, p.currency
       FROM marketplace_products p
       JOIN sellers s ON s.id = p.seller_id
      WHERE s.user_id = $1 AND p.status = 'active'
      ORDER BY p.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
