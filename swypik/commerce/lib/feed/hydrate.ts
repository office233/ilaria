/**
 * Hidratarea: datele complete de afișare pentru o listă de id-uri deja clasate
 * (ordinea din listă se păstrează). Reaplică vizibilitatea; produsul se
 * atașează DOAR dacă e eligibil — un produs arhivat nu mai ascunde clipul.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { getMissionBadges } from "@/lib/missions/feed-badge";
import { mediaPublicBaseUrl } from "@/lib/storage/config";
import { toFeedVideo, type HydratedRow } from "./dto";
import type { FeedVideo } from "./types";
import { CAPTIONS_ENABLED_SQL, LINKED_PRODUCT_ID_SQL, notHiddenByViewerSql, productAttachSql, visibleVideoSql } from "./visibility";

export type HydrateOptions = {
  userId: string | null;
  sessionId: string | null;
  /** Ascunde categoriile „soft” de produse (doar For You implicit). */
  softBlock: boolean;
};

function publicMediaBase(): string {
  return mediaPublicBaseUrl();
}

export function buildHydrateSql(opts: HydrateOptions): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const idsP = bind([]);
  const userP = opts.userId ? bind(opts.userId) : null;
  const sessP = opts.sessionId ? bind(opts.sessionId) : null;
  const movies = isEnabled("movies");

  const viewerVoteCond = [userP ? `user_id = ${userP}::uuid` : "", sessP ? `(user_id IS NULL AND session_id = ${sessP})` : ""]
    .filter(Boolean)
    .join(" OR ");

  const sql = `
    SELECT v.id::text AS video_id, v.creator_id::text AS creator_id, v.description, v.title,
           v.playback_url, v.thumbnail_url, v.duration_ms,
           v.like_count, v.save_count, v.share_count, v.comment_count,
           u.display_name AS creator_name, u.username AS creator_username,
           u.is_verified AS creator_verified, u.avatar_url AS creator_avatar,
           va.object_key AS source_key, v.metadata->>'preview_url' AS preview_url,
           p.id::text AS mp_id, p.title AS mp_title, p.price_cents AS mp_price_cents, p.image_url AS mp_image_url,
           p.currency AS mp_currency, p.inventory_status AS mp_inventory_status,
           p.shipping_cost_cents AS mp_shipping_cost_cents, p.taxonomy_node_slug AS mp_taxonomy_node_slug,
           p.metadata AS mp_metadata,
           (SELECT vpl.placement FROM video_product_links vpl WHERE vpl.video_id = v.id AND vpl.product_id = p.id LIMIT 1) AS product_placement,
           (SELECT COUNT(*) FROM video_product_votes vv WHERE vv.video_id = v.id AND vv.product_id = p.id AND vv.vote = 'worth_it')::int AS worth_it_count,
           (SELECT COUNT(*) FROM video_product_votes vv WHERE vv.video_id = v.id AND vv.product_id = p.id AND vv.vote = 'not_worth_it')::int AS not_worth_it_count,
           ${viewerVoteCond
             ? `(SELECT vote FROM video_product_votes WHERE video_id = v.id AND product_id = p.id AND (${viewerVoteCond})
                 ORDER BY CASE WHEN user_id IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC LIMIT 1)`
             : "NULL::text"} AS viewer_product_vote,
           at.id::text AS at_id, at.title AS at_title, at.artist AS at_artist, at.image_url AS at_image_url,
           ${movies
             ? `ms.slug AS movie_slug, ms.title AS movie_title, me.episode_number AS movie_episode_number,
                (SELECT COUNT(*)::int FROM movie_episodes me2 WHERE me2.series_id = ms.id AND me2.status = 'published') AS movie_episode_count,`
             : `NULL::text AS movie_slug, NULL::text AS movie_title, NULL::int AS movie_episode_number, NULL::int AS movie_episode_count,`}
           -- Comutatorul „Subtitrări” al creatorului (metadata.captions_enabled=false → fără piste).
           ARRAY(SELECT c.lang FROM video_captions c WHERE c.video_id = v.id AND ${CAPTIONS_ENABLED_SQL} ORDER BY c.lang) AS caption_langs,
           ${userP ? `EXISTS(SELECT 1 FROM likes l WHERE l.user_id = ${userP}::uuid AND l.video_id = v.id)` : "false"} AS viewer_liked,
           ${userP ? `EXISTS(SELECT 1 FROM saves s WHERE s.user_id = ${userP}::uuid AND s.video_id = v.id)` : "false"} AS viewer_saved,
           ${userP ? `EXISTS(SELECT 1 FROM follows f WHERE f.follower_user_id = ${userP}::uuid AND f.following_user_id = v.creator_id)` : "false"} AS viewer_following
      FROM videos v
      LEFT JOIN users u ON u.id = v.creator_id
      LEFT JOIN LATERAL (
        SELECT object_key FROM video_assets WHERE video_id = v.id AND asset_type = 'source' ORDER BY created_at DESC LIMIT 1
      ) va ON true
      LEFT JOIN marketplace_products p ON p.id = ${LINKED_PRODUCT_ID_SQL} AND ${productAttachSql({ softBlock: opts.softBlock })}
      LEFT JOIN audio_tracks at ON at.id = v.audio_track_id
      ${movies ? `LEFT JOIN movie_episodes me ON me.video_id = v.id LEFT JOIN movie_series ms ON ms.id = me.series_id` : ""}
     WHERE v.id = ANY(${idsP}::uuid[])
       AND ${visibleVideoSql()}
       ${notHiddenByViewerSql(userP)}`;
  return { sql, params };
}

/** Clipurile vizibile din `ids`, în ordinea primită (cele dispărute între timp sunt omise). */
export async function hydrateVideos(ids: readonly string[], opts: HydrateOptions): Promise<FeedVideo[]> {
  if (ids.length === 0) return [];
  const { sql, params } = buildHydrateSql(opts);
  params[0] = ids;
  const [{ rows }, badges] = await Promise.all([dbQuery<HydratedRow>(sql, params), getMissionBadges(ids)]);
  const byId = new Map(rows.map((r) => [String(r.video_id), r]));
  const base = publicMediaBase();
  const out: FeedVideo[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(toFeedVideo(row, base, badges.get(id) ?? null));
  }
  return out;
}
