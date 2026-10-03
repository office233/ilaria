import { NextResponse } from "next/server";
import { searchProducts } from "@/lib/db/product-queries";
import { proxyToSocialApi } from "@/lib/social/proxy";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { dbQuery } from "@/lib/db";

import { logger } from "@/lib/logger";
import { applyCachePolicy, applyNoStore } from "@/lib/http/cache-policy";
export const dynamic = "force-dynamic";

// Cache: lib/http/cache-policy.ts ("v1/feed", audiență anonimă). Cu cookie de
// identitate (sesiune, anon, feed_sid) răspunsul e personalizat (ordinea
// clipurilor, `viewerVote`, seen-set) → `private, no-store`; fără → edge.

function toInt(value: string | null, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

type FeedProduct = {
  id: string | number;
  pgId?: number | null;
  likes?: number;
  commentCount?: number;
  orders?: number;
  rating?: number;
  discountPercent?: number;
  product_id?: string | number;
  productId?: string | number;
  video_id?: string;
  videoId?: string;
  creator_id?: string;
  creatorId?: string;
  video?: string | null;
  images?: string[];
};

type ExploreVideo = {
  id: string | number;
  url?: string | null;
  hlsUrl?: string | null;
  fallbackUrl?: string | null;
  thumbnail?: string | null;
  likes?: unknown;
  comments?: unknown;
  saves?: unknown;
  shares?: unknown;
  creator?: { id?: string; username?: string; name?: string; avatar?: string | null } | null;
  product?: { id?: string | number; swypikScore?: unknown } | null;
  /** Starea viewerului (liked/saved/following) din explore/feed. */
  viewer?: { liked?: boolean; saved?: boolean; following?: boolean } | null;
};

function toFeedItem(product: FeedProduct, index: number, seed: number) {
  // 2026-08-10: fara engagement sintetic — doar numere reale (0 daca nu exista).
  const likes = product.likes || 0;
  const comments = product.commentCount || 0;
  const productId = String(product.pgId || product.product_id || product.productId || product.id);
  const numericProductId = Number(product.pgId || product.id);
  const videoId = product.video_id || product.videoId || (product.video ? `product_${product.id}` : `feed_${product.id}`);
  const creatorId = product.creator_id || product.creatorId || "swypik";
  const videoUrl = typeof product.video === "string" ? product.video : null;
  const isHls = videoUrl ? /\.m3u8(\?|$)/i.test(videoUrl) : false;
  const score =
    (product.orders || 0) * 0.45 +
    (product.rating || 0) * 80 +
    (product.discountPercent || 0) * 6 +
    ((seed + index * 97) % 100);

  return {
    id: `feed_${product.id}`,
    product_id: productId,
    productId: Number.isFinite(numericProductId) && numericProductId > 0 ? numericProductId : productId,
    video_id: videoId,
    videoId,
    creator_id: creatorId,
    creatorId,
    creator: {
      id: creatorId,
      username: "Swypik",
      displayName: "Swypik",
      avatarUrl: null,
    },
    video: {
      hlsUrl: isHls ? videoUrl : null,
      mp4Url: videoUrl && !isHls ? videoUrl : null,
      posterUrl: product.images?.[0] || null,
      status: videoUrl ? "ready" : "poster_only",
    },
    product: {
      ...product,
      product_id: productId,
      productId: Number.isFinite(numericProductId) && numericProductId > 0 ? numericProductId : productId,
      video_id: videoId,
      videoId,
      creator_id: creatorId,
      creatorId,
    },
    stats: {
      likes,
      comments,
      saves: 0,
      shares: 0,
      orders: product.orders || 0,
    },
    ranking: {
      score,
      reason: product.video ? "video_commerce_seeded" : "commerce_seeded",
    },
  };
}

function toExploreFeedItem(video: ExploreVideo, index: number, seed: number) {
  const productId = video.product?.id ? String(video.product.id) : null;
  const likes = Number(video.likes) || 0;
  const comments = Number(video.comments) || 0;
  const creatorId = video.creator?.id || "swypik";
  const score = (Number(video.product?.swypikScore) || 60) + ((seed + index * 31) % 10);

  return {
    id: String(video.id),
    product_id: productId,
    productId: productId,
    video_id: String(video.id),
    videoId: String(video.id),
    creator_id: creatorId,
    creatorId,
    creator: {
      id: creatorId,
      username: video.creator?.username || "swypik-system",
      displayName: video.creator?.name || "Swypik",
      avatarUrl: video.creator?.avatar || null,
    },
    video: {
      hlsUrl: video.hlsUrl || null,
      // 2026-08-13 (audit): mp4Url primea `video.url` care e chiar master.m3u8
      // (HLS) => playerele care prefera progressive mp4 incercau sa redea un
      // playlist ca mp4 si esuau. Servim doar un mp4 real (fallbackUrl).
      mp4Url:
        video.fallbackUrl && !/\.m3u8(\?|$)/i.test(video.fallbackUrl)
          ? video.fallbackUrl
          : video.url && !/\.m3u8(\?|$)/i.test(video.url)
            ? video.url
            : null,
      posterUrl: video.thumbnail || null,
      status: video.url ? "ready" : "poster_only",
    },
    product: video.product || null,
    stats: {
      likes,
      comments,
      saves: Number(video.saves) || 0,
      shares: Number(video.shares) || 0,
      orders: 0,
    },
    ranking: {
      score,
      reason: "explore_feed_filtered",
    },
  };
}

// Consumatorii (ProductFeed prin feed-normalize) citesc video_id/creator_id de pe
// obiectul `product` — fara ele, like-urile se trimiteau catre UUID-ul produsului
// si esuau cu 404 (audit 2026-08-24). Pastram acelasi contract ca toFeedItem.
function withVideoRefs<T extends { product: unknown }>(
  item: T & { video_id: string; creator_id: string },
  viewerLiked: boolean,
): T {
  if (item.product && typeof item.product === "object") {
    item.product = {
      ...(item.product as Record<string, unknown>),
      video_id: item.video_id,
      videoId: item.video_id,
      creator_id: item.creator_id,
      creatorId: item.creator_id,
      // Fără asta, inima de pe homepage apărea gri după refresh chiar dacă
      // like-ul era salvat în DB (audit 2026-08-25).
      viewerLiked,
    };
  }
  return item;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = toInt(url.searchParams.get("limit"), 15, 1, 50);
    const offset = toInt(url.searchParams.get("offset"), 0, 0, 100000);
    const seed = toInt(url.searchParams.get("seed"), 0, 0, 1000000);

    if (url.searchParams.get("source") === "platform") {
      const proxied = await proxyToSocialApi(req, "/v1/feed");
      if (proxied) return proxied;
    }

    try {
      const page = Math.floor(offset / limit) + 1;
      // Avoid round-tripping through Caddy → self (causes deadlock on swypik.com).
      // Hit the same Node process on loopback directly.
      const internalBase = process.env.INTERNAL_APP_URL || "http://127.0.0.1:3000";
      const exploreUrl = new URL("/api/explore/feed", internalBase);
      exploreUrl.searchParams.set("limit", String(limit));
      exploreUrl.searchParams.set("page", String(page));
      const cookie = req.headers.get("cookie");
      const exploreResponse = await fetch(exploreUrl, {
        cache: "no-store",
        headers: cookie ? { cookie } : undefined,
        signal: AbortSignal.timeout(8_000),
      });
      if (exploreResponse.ok) {
        const payload = await exploreResponse.json();
        const videos: ExploreVideo[] = Array.isArray(payload?.videos) ? payload.videos : [];
        const items = videos.map((video, index) =>
          withVideoRefs(toExploreFeedItem(video, offset + index, seed), Boolean(video.viewer?.liked)));
        return applyCachePolicy(
          NextResponse.json({
            items,
            products: items.map((item) => item.product).filter(Boolean),
            paging: {
              offset,
              limit,
              nextOffset: payload?.hasMore ? offset + items.length : null,
              total: null,
            },
            source: "explore-feed",
          }),
          "v1/feed",
          req,
        );
      }
    } catch (e) {
      logger.warn({ err: e }, "[v1/feed] explore-feed bridge failed");
    }

    const result = await searchProducts({
      mode: "video",
      sort: "popular",
      limit,
      offset,
      seed,
    });

    const items = result.products.map((product, index) =>
      toFeedItem(product, offset + index, seed)
    );

    const userId = await getOptionalSocialUserId().catch(() => null);
    let visibleItems = items;
    if (userId) {
      try {
        const { rows } = await dbQuery<{ seen_video_ids: string[] }>(
          "SELECT seen_video_ids FROM user_feed_state WHERE user_id = $1::uuid AND feed_type = 'for_you' LIMIT 1",
          [userId],
        );
        const seen = new Set<string>(Array.isArray(rows?.[0]?.seen_video_ids) ? rows[0].seen_video_ids as string[] : []);
        if (seen.size > 0) {
          visibleItems = items.filter((it) => !seen.has(String(it.video_id)));
          if (visibleItems.length === 0) visibleItems = items;
        }
        const newIds = visibleItems.map((it) => String(it.video_id)).filter(Boolean);
        if (newIds.length > 0) {
          const merged = Array.from(new Set([...newIds.reverse(), ...Array.from(seen)])).slice(0, 500);
          await dbQuery(
            `INSERT INTO user_feed_state (user_id, feed_type, seen_video_ids, last_refreshed_at, updated_at)
             VALUES ($1::uuid, 'for_you', $2::jsonb, NOW(), NOW())
             ON CONFLICT (user_id, feed_type)
             DO UPDATE SET seen_video_ids = EXCLUDED.seen_video_ids, last_refreshed_at = NOW(), updated_at = NOW()`,
            [userId, JSON.stringify(merged)],
          );
        }
      } catch (e) {
        logger.warn({ err: e }, "[v1/feed] seen-tracking failed");
      }
    }

    const nextOffset = offset + result.products.length;

    // Lista e filtrată după `seen_video_ids` când există viewer ⇒ personalizată.
    const res = NextResponse.json({
      items: visibleItems,
      products: result.products,
      paging: {
        offset,
        limit,
        nextOffset: nextOffset < result.total ? nextOffset : null,
        total: result.total,
      },
      source: "next-fallback",
    });
    return userId ? applyNoStore(res) : applyCachePolicy(res, "v1/feed", req);
  } catch (error) {
    logger.error({ err: error }, "[Social Feed Fallback]");
    return NextResponse.json({ items: [], products: [], error: "Feed unavailable" }, { status: 500 });
  }
}
