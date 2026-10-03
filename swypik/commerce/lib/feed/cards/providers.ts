/**
 * Registrul producătorilor de carduri pe tip. Un tip e cerut doar când are
 * sloturi datorate în pagina curentă (interleave.cardDemand); un producător
 * care cade (sau un modul lipsă) lasă pur și simplu pozițiile clipurilor.
 * Un modul cu flag OFF nu produce carduri: Movies/Music/News după flag-ul de
 * server, Food/Stays/Live după flag-ul de vizibilitate (NEXT_PUBLIC_FEATURE_X,
 * același care îl ascunde din meniu) — feed-ul nu trimite spre module ascunse.
 */
import { isEnabled } from "@/lib/feature-flags";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { logger } from "@/lib/logger";
import { FEED_ITEMS_MAX_LIMIT } from "@/lib/media/feed-card";
import { getMovieFeedItems } from "@/lib/movies/feed-items";
import { getMusicFeedItems } from "@/lib/music/feed-items";
import { getStaysFeedItems } from "@/lib/stays/feed-items";
import type { FeedCard, FeedCardKind } from "../types";
import { fromLiveItem, fromModuleCard, fromNewsItem, fromStayItem, isLiveFeedInput, isNewsFeedInput } from "./adapters";
import { getFoodFeedCards, getShopFeedCards } from "./commerce";
import { loadOptionalProducer } from "./optional";

export type CardContext = { locale: string };
type Provider = (limit: number, ctx: CardContext) => Promise<FeedCard[]>;

const notNull = <T>(x: T | null): x is T => x !== null;

async function optionalCards<T>(
  name: "live" | "news",
  limit: number,
  guard: (x: unknown) => x is T,
  map: (x: T) => FeedCard,
): Promise<FeedCard[]> {
  const producer = await loadOptionalProducer(name);
  if (!producer) return [];
  const items = await producer({ limit });
  return Array.isArray(items) ? items.filter(guard).map(map) : [];
}

export const CARD_PROVIDERS: Record<FeedCardKind, Provider> = {
  product: (limit) => getShopFeedCards(limit),
  food: async (limit) => (isEnabledClient("food") ? getFoodFeedCards(limit) : []),
  movie: async (limit) =>
    isEnabled("movies") ? (await getMovieFeedItems({ limit })).map(fromModuleCard).filter(notNull) : [],
  music: async (limit) =>
    isEnabled("music") ? (await getMusicFeedItems({ limit })).map(fromModuleCard).filter(notNull) : [],
  stay: async (limit, ctx) =>
    isEnabledClient("stays") ? (await getStaysFeedItems({ limit, locale: ctx.locale })).map(fromStayItem) : [],
  live: async (limit) => (isEnabledClient("live") ? optionalCards("live", limit, isLiveFeedInput, fromLiveItem) : []),
  news: (limit) => (isEnabled("news") ? optionalCards("news", limit, isNewsFeedInput, fromNewsItem) : Promise.resolve([])),
};

/** Pool-urile de carduri pentru cererea dată (tip → câte). */
export async function loadCardPools(
  demand: ReadonlyMap<FeedCardKind, number>,
  ctx: CardContext,
  providers: Record<FeedCardKind, Provider> = CARD_PROVIDERS,
): Promise<Map<FeedCardKind, FeedCard[]>> {
  const kinds = Array.from(demand.keys());
  const settled = await Promise.allSettled(
    kinds.map((k) => providers[k](Math.min(FEED_ITEMS_MAX_LIMIT, Math.max(1, demand.get(k) ?? 1)), ctx)),
  );
  const pools = new Map<FeedCardKind, FeedCard[]>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") pools.set(kinds[i], r.value);
    else logger.warn({ err: r.reason, kind: kinds[i] }, "[feed/cards] provider failed");
  });
  return pools;
}
