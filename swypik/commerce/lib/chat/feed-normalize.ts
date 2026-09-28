/**
 * Normalizarea feed-ului social în ChatProduct-uri.
 * Extras din ChatInterface.tsx (Faza C — split god components).
 */
import type { Product } from "@/types/product";
import { APP_URL } from "@/lib/app-url";

type ChatProduct = Product;

export function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function isSafeDirectVideoUrl(value?: string) {
  if (!value) return false;
  if (value.startsWith("/")) return true;

  try {
    const fallbackOrigin = APP_URL;
    const currentOrigin = typeof window === "undefined" ? fallbackOrigin : window.location.origin;
    const parsed = new URL(value, currentOrigin);
    return parsed.origin === currentOrigin;
  } catch {
    return false;
  }
}

export function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

export function normalizeSocialFeedProducts(data: any): ChatProduct[] {
  const rawItems = Array.isArray(data?.items) ? data.items : Array.isArray(data?.products) ? data.products : [];

  return rawItems
    .map((item: any) => {
      const source = item?.product || item;
      const title = firstString(source?.title, source?.product_title, item?.productTitle);
      if (!title) return null;

      const price = firstNumber(source.price, source.price_ron, source.priceRON, source.product_price);
      const oldPrice = firstNumber(source.oldPrice, source.old_price_ron, source.oldPriceRON) || price;
      const numericPgId = Number(source.pgId || source.productId || source.product_id || item.productId || item.product_id || source.id);
      const videoUrl =
        item?.video?.hlsUrl ||
        item?.video?.mp4Url ||
        item?.video?.url ||
        item?.videoUrl ||
        source.hls_url ||
        source.video_url ||
        source.video ||
        undefined;
      const imageUrl = firstString(
        item?.video?.posterUrl,
        source.poster_url,
        source.thumbnail_url,
        source.product_image,
        source.image_url
      );
      const images = Array.isArray(source.images) && source.images.length
        ? source.images
        : imageUrl
          ? [imageUrl]
          : [];
      const discountPercent =
        Number(source.discountPercent) ||
        (oldPrice > price && price > 0 ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0);

      // video_id-ul real e obligatoriu pentru like-uri persistente — fara el,
      // ProductFeed trimitea POST /api/videos/{uuid-de-produs}/like → 404.
      const videoId = firstString(item?.video_id, item?.videoId, source?.video_id, source?.videoId);
      const viewerLiked = Boolean(source?.viewerLiked ?? item?.viewer?.liked);

      return {
        ...source,
        id: String(source.id || item.video_id || item.productId || item.product_id || item.id),
        video_id: videoId || undefined,
        videoId: videoId || undefined,
        viewerLiked,
        pgId: Number.isFinite(numericPgId) && numericPgId > 0 ? numericPgId : source.pgId,
        aeProductId: source.aeProductId || source.ae_product_id,
        description: source.description || title,
        benefits: source.benefits || [],
        dealLabel: source.dealLabel || "AI Pick",
        whyBuy: source.whyBuy || "",
        warnings: source.warnings || [],
        title,
        price,
        oldPrice,
        discountPercent,
        rating: Number(source.rating) || 0,
        orders: Number(source.orders) || Number(source.orders_count) || Number(source.view_count) || item?.stats?.orders || 0,
        deliveryDays: Number(source.deliveryDays) || 0,
        images,
        video: videoUrl,
        hasVideo: Boolean(videoUrl || source.hasVideo || source.video_url || source.hls_url),
        category: source.category || "General",
        categoryId: Number(source.categoryId || source.category_id) || undefined,
        gradient: source.gradient || "from-orange-500 to-pink-500",
        qualityScore: Number(source.qualityScore || source.rank_score) || 8,
        likes: Number(source.likes) || Number(source.likes_count) || Number(source.like_count) || item?.stats?.likes,
        commentCount: Number(source.commentCount) || Number(source.comment_count) || item?.stats?.comments,
      } satisfies ChatProduct;
    })
    .filter(Boolean) as ChatProduct[];
}

export async function fetchSocialFeed(offset: number, seed: number) {
  const res = await fetch(`/api/v1/feed?limit=15&offset=${offset}&seed=${seed}`);
  if (!res.ok) throw new Error("Social feed unavailable");
  return normalizeSocialFeedProducts(await res.json());
}
