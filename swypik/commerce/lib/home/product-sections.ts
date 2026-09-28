/**
 * Datele pentru Discover (fostul home de produse): secțiunile trending /
 * best value / top rated + feed-ul de oferte. Cache ISR 120s.
 */
import { unstable_cache } from "next/cache";
import { searchProducts } from "@/lib/db/product-queries";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { OfferPost } from "@/lib/types/feed";

type ProductSearchResult = Awaited<ReturnType<typeof searchProducts>>;
type SearchProduct = ProductSearchResult["products"][number];

const emptyResult: ProductSearchResult = { products: [], total: 0, offset: 0, limit: 0, hasMore: false };
const SECTION_LIMIT = 20;
const OFFER_CANDIDATES = 36;
const OFFER_LIMIT = 12;
const QUERY_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function firstImage(p: SearchProduct): string | undefined {
  const images = (p as { images?: unknown }).images;
  const img = Array.isArray(images) ? images[0] : undefined;
  return typeof img === "string" && /^https?:\/\//.test(img) ? img : undefined;
}

type StatsRow = { product_id: string; like_count: number | string | null; share_count: number | string | null };
type SellerRow = { product_id: string; is_verified: boolean | null; name: string | null };

async function loadOffers(): Promise<OfferPost[]> {
  const feedResult = await withTimeout(
    searchProducts({ mode: "trending", sort: "popular", limit: OFFER_CANDIDATES }),
    QUERY_TIMEOUT_MS,
    emptyResult,
  );
  const candidates = feedResult.products
    .filter((p) => (p as { hasValidPrice?: boolean }).hasValidPrice && firstImage(p))
    .slice(0, OFFER_LIMIT);
  const ids = candidates.map((p) => String(p.id));
  if (ids.length === 0) return [];

  const [stats, sellers] = await Promise.all([
    dbQuery<StatsRow>(
      `SELECT product_id, like_count, share_count FROM product_stats WHERE product_id = ANY($1::uuid[])`,
      [ids],
    ).catch(() => ({ rows: [] as StatsRow[] })),
    dbQuery<SellerRow>(
      `SELECT p.id AS product_id, s.is_verified, s.name
         FROM marketplace_products p JOIN sellers s ON s.id = p.seller_id
        WHERE p.id = ANY($1::uuid[])`,
      [ids],
    ).catch(() => ({ rows: [] as SellerRow[] })),
  ]);
  const statsMap = new Map(
    stats.rows.map((r) => [String(r.product_id), { like: Number(r.like_count) || 0, share: Number(r.share_count) || 0 }]),
  );
  const sellerMap = new Map(
    sellers.rows.map((r) => [String(r.product_id), { verified: Boolean(r.is_verified), name: r.name ?? null }]),
  );

  return candidates.map((p) => {
    const id = String(p.id);
    const extra = p as unknown as {
      oldPrice?: number;
      discountPercent?: number;
      rating?: number;
      orders?: number;
      vendor?: string;
      category?: string;
      categoryId?: number;
      shipFree?: boolean;
    };
    return {
      id,
      title: p.title,
      image: firstImage(p) ?? "",
      price: Number(p.price) || 0,
      oldPrice: Number(extra.oldPrice) || 0,
      discountPercent: extra.discountPercent ?? 0,
      currency: "RON",
      rating: extra.rating ?? 0,
      orders: extra.orders ?? 0,
      brand: sellerMap.get(id)?.name || extra.vendor || extra.category || "Swypik",
      category: extra.category || "General",
      categoryId: extra.categoryId,
      shipFree: Boolean(extra.shipFree),
      likeCount: statsMap.get(id)?.like ?? 0,
      shareCount: statsMap.get(id)?.share ?? 0,
      viewerLiked: false,
      sellerVerified: sellerMap.get(id)?.verified ?? false,
    };
  });
}

export const getDiscoverSections = unstable_cache(
  async () => {
    let trending = emptyResult;
    let bestValue = emptyResult;
    let topRated = emptyResult;
    let offers: OfferPost[] = [];
    try {
      [trending, bestValue, topRated] = await Promise.all([
        withTimeout(searchProducts({ mode: "trending", limit: SECTION_LIMIT }), QUERY_TIMEOUT_MS, emptyResult),
        withTimeout(searchProducts({ mode: "bestvalue", limit: SECTION_LIMIT }), QUERY_TIMEOUT_MS, emptyResult),
        withTimeout(searchProducts({ mode: "toprated", limit: SECTION_LIMIT }), QUERY_TIMEOUT_MS, emptyResult),
      ]);
    } catch (err) {
      logger.error({ err }, "[discover] product sections failed");
    }
    try {
      offers = await loadOffers();
    } catch (err) {
      logger.error({ err }, "[discover] offers feed failed");
    }
    return { trending, bestValue, topRated, offers };
  },
  ["discover-product-sections-v1"],
  { revalidate: 120 },
);
