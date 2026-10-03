/**
 * Maparea rând DB → FeedVideo (pură, testabilă). Fără texte traduse pe server:
 * eticheta de livrare, prețul formatat etc. le face UI-ul în limba viewerului.
 */
import type { MissionBadge } from "@/lib/missions/feed-badge";
import type { FeedVideo, FeedVideoProduct } from "./types";

export type HydratedRow = {
  video_id: string;
  creator_id: string | null;
  description: string | null;
  title: string | null;
  playback_url: string | null;
  thumbnail_url: string | null;
  duration_ms: number | string | null;
  like_count: number | string | null;
  save_count: number | string | null;
  share_count: number | string | null;
  comment_count: number | string | null;
  creator_name: string | null;
  creator_username: string | null;
  creator_verified: boolean | null;
  creator_avatar: string | null;
  source_key: string | null;
  preview_url: string | null;
  mp_id: string | null;
  mp_title: string | null;
  mp_price_cents: number | string | null;
  mp_image_url: string | null;
  mp_currency: string | null;
  mp_inventory_status: string | null;
  mp_shipping_cost_cents: number | string | null;
  mp_taxonomy_node_slug: string | null;
  mp_metadata: Record<string, unknown> | null;
  product_placement: string | null;
  worth_it_count: number | string | null;
  not_worth_it_count: number | string | null;
  viewer_product_vote: string | null;
  at_id: string | null;
  at_title: string | null;
  at_artist: string | null;
  at_image_url: string | null;
  movie_slug: string | null;
  movie_title: string | null;
  movie_episode_number: number | null;
  movie_episode_count: number | null;
  caption_langs: string[] | null;
  viewer_liked: boolean | null;
  viewer_saved: boolean | null;
  viewer_following: boolean | null;
};

const HLS_RE = /\.m3u8(\?|$)/i;

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function count(v: number | string | null | undefined): number {
  return Math.max(0, num(v) ?? 0);
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}

export function toFeedProduct(row: HydratedRow): FeedVideoProduct | null {
  if (!row.mp_id) return null;
  const priceCents = num(row.mp_price_cents);
  const worthIt = count(row.worth_it_count);
  const notWorthIt = count(row.not_worth_it_count);
  const title = row.mp_title ?? "";
  return {
    id: String(row.mp_id),
    name: title,
    title,
    image: row.mp_image_url || null,
    image_url: row.mp_image_url || null,
    priceCents,
    price: priceCents != null ? priceCents / 100 : null,
    currency: String(row.mp_currency || "RON").trim().toUpperCase(),
    shippingCents: num(row.mp_shipping_cost_cents),
    inventoryStatus: row.mp_inventory_status || null,
    taxonomyNodeSlug: row.mp_taxonomy_node_slug || null,
    ctaUrl: metaString(row.mp_metadata, "cta_url"),
    vertical: metaString(row.mp_metadata, "vertical"),
    linkPlacement: row.product_placement || "product_refs",
    votes: { worthIt, notWorthIt, total: worthIt + notWorthIt, viewerVote: row.viewer_product_vote || null },
  };
}

export function toFeedVideo(row: HydratedRow, publicMediaBase: string, mission: MissionBadge | null): FeedVideo {
  const base = publicMediaBase.replace(/\/$/, "");
  const sourceUrl = row.source_key && base ? `${base}/${row.source_key}` : null;
  const url = row.playback_url || sourceUrl;
  // MP4 de rezervă = preview.mp4 transcodat (H.264, faststart); sursa brută doar pentru clipurile vechi.
  const fallbackUrl = row.preview_url || (sourceUrl && row.playback_url && sourceUrl !== row.playback_url ? sourceUrl : null);
  const durationMs = num(row.duration_ms);
  return {
    id: String(row.video_id),
    url: url || null,
    hlsUrl: url && HLS_RE.test(url) ? url : null,
    fallbackUrl,
    thumbnail: row.thumbnail_url || (row.source_key && base ? `${base}/videos/thumbnails/${row.video_id}.jpg` : null),
    duration: durationMs ? Math.round(durationMs / 1000) : null,
    creator: {
      id: row.creator_id ? String(row.creator_id) : "",
      name: row.creator_name || row.creator_username || "",
      username: row.creator_username || null,
      verified: Boolean(row.creator_verified),
      avatar: row.creator_avatar || null,
    },
    description: row.description || row.title || "",
    likes: count(row.like_count),
    saves: count(row.save_count),
    shares: count(row.share_count),
    comments: count(row.comment_count),
    viewer: {
      liked: Boolean(row.viewer_liked),
      saved: Boolean(row.viewer_saved),
      following: Boolean(row.viewer_following),
    },
    product: toFeedProduct(row),
    audioTrack: row.at_id
      ? { id: String(row.at_id), title: row.at_title || null, artist: row.at_artist || null, image_url: row.at_image_url || null }
      : null,
    movie: row.movie_slug
      ? {
          slug: row.movie_slug,
          title: row.movie_title ?? "",
          episode: row.movie_episode_number ?? 1,
          episodeCount: row.movie_episode_count ?? 0,
        }
      : null,
    mission,
    captionLangs: Array.isArray(row.caption_langs) ? row.caption_langs.filter((l) => /^[a-z]{2}$/.test(l)) : [],
  };
}
