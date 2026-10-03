/**
 * Sursa de date a feed-ului pe client (Home + /explore).
 *
 * UI-ul cere „pagina următoare” cu cursorul primit și primește itemi
 * unificați (clipuri + carduri de modul) — contract în lib/feed/types.ts.
 */
import type { FeedItem, FeedSource } from "@/lib/feed/types";

export type FeedQuery = {
  /** Cursorul opac din răspunsul anterior; absent = prima pagină. */
  cursor?: string | null;
  source?: FeedSource;
  /** Slug de taxonomie (filtru de categorie). */
  category?: string;
  /** Doar clipurile unui creator (context de profil). */
  creatorId?: string;
  /** Clip fixat primul (deep link `?v=`); trimis doar pe prima pagină. */
  pinnedVideoId?: string;
  sessionId?: string;
  locale?: string;
  limit?: number;
};

export type FeedPage = {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  requestId: string | null;
  ab: string | null;
};

export const FEED_PAGE_SIZE = 12;
const FEED_ENDPOINT = "/api/explore/feed";

export function buildFeedUrl(q: FeedQuery): string {
  const sp = new URLSearchParams();
  sp.set("limit", String(q.limit ?? FEED_PAGE_SIZE));
  if (q.cursor) sp.set("cursor", q.cursor);
  if (q.source === "following") sp.set("source", "following");
  if (q.category) sp.set("category", q.category);
  if (q.sessionId) sp.set("session_id", q.sessionId);
  if (q.locale) sp.set("locale", q.locale);
  if (q.pinnedVideoId && !q.cursor) sp.set("v", q.pinnedVideoId);
  if (q.creatorId) sp.set("creator_id", q.creatorId);
  return `${FEED_ENDPOINT}?${sp.toString()}`;
}

function isFeedItem(x: unknown): x is FeedItem {
  if (!x || typeof x !== "object") return false;
  const o = x as { kind?: unknown; key?: unknown; video?: unknown; card?: unknown };
  if (typeof o.kind !== "string" || typeof o.key !== "string") return false;
  return o.kind === "video" ? Boolean(o.video && typeof o.video === "object") : Boolean(o.card && typeof o.card === "object");
}

/** Normalizează răspunsul API-ului (tolerant la câmpuri lipsă). */
export function parseFeedPage(data: unknown): FeedPage {
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const nextCursor = typeof obj.nextCursor === "string" && obj.nextCursor ? obj.nextCursor : null;
  return {
    items: Array.isArray(obj.items) ? obj.items.filter(isFeedItem) : [],
    nextCursor,
    hasMore: Boolean(obj.hasMore) && nextCursor !== null,
    requestId: typeof obj.requestId === "string" ? obj.requestId : null,
    ab: typeof obj.ab === "string" ? obj.ab : null,
  };
}

/** `null` la eroare HTTP (apelantul decide ce afișează). */
export async function fetchFeedPage(q: FeedQuery, init?: RequestInit): Promise<FeedPage | null> {
  const res = await fetch(buildFeedUrl(q), init);
  if (!res.ok) return null;
  return parseFeedPage(await res.json());
}
