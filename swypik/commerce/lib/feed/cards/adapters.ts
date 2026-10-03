/**
 * Adaptoare pure: cardurile produse de module → `FeedCard` normalizat.
 *
 * CONTRACTUL PENTRU MODULELE NOI (live, news, …): fișierul `lib/<modul>/feed-items.ts`
 * exportă `get<Modul>FeedItems({ limit }): Promise<Item[]>`; forma item-ului
 * e descrisă de tipurile `*FeedInput` de mai jos (structural — nu importăm
 * modulul, deci feed-ul compilează și fără el; vezi ./optional.ts).
 */
import type { ModuleFeedCard } from "@/lib/media/feed-card";
import type { StayFeedItem } from "@/lib/stays/feed-items";
import type { FeedCard } from "../types";

const EMPTY = { price: null, summary: null, attribution: null, sourceUrl: null, viewerCount: null, isFree: null } as const;

export function fromModuleCard(c: ModuleFeedCard): FeedCard | null {
  // Feed-ul e monetizat: doar conținut cu licență comercială.
  if (!c.licensedForCommercial) return null;
  return {
    ...EMPTY,
    kind: c.kind === "movie_title" ? "movie" : "music",
    id: c.id,
    title: c.title,
    subtitle: c.subtitle,
    image: c.image,
    href: c.href,
    attribution: c.attribution,
    isFree: c.isFree,
  };
}

export function fromStayItem(s: StayFeedItem): FeedCard {
  return {
    ...EMPTY,
    kind: "stay",
    id: s.id,
    title: s.title,
    subtitle: s.subtitle,
    image: s.image,
    href: s.href,
    price: { cents: s.priceCents, currency: s.currency, unit: "night" },
  };
}

/** Forma așteptată de la lib/live/feed-items.ts (`getLiveFeedItems`). */
export type LiveFeedInput = {
  kind: "live";
  id: string;
  href: string;
  title: string;
  viewerCount: number;
  creator: { username: string | null; displayName: string | null; avatarUrl: string | null };
};

/** Forma așteptată de la lib/news/feed-items.ts (`getNewsFeedItems`). */
export type NewsFeedInput = {
  kind: "news";
  id: string;
  title: string;
  summary: string;
  image: string | null;
  href: string;
  categoryName: string;
  sourceName: string;
  sourceUrl: string;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const internalHref = (x: unknown): x is string => str(x) && x.startsWith("/") && !x.startsWith("//");

export function isLiveFeedInput(x: unknown): x is LiveFeedInput {
  return (
    isRecord(x) && x.kind === "live" && str(x.id) && internalHref(x.href) && str(x.title) && isRecord(x.creator)
  );
}

export function isNewsFeedInput(x: unknown): x is NewsFeedInput {
  return (
    isRecord(x) && x.kind === "news" && str(x.id) && internalHref(x.href) && str(x.title) &&
    str(x.sourceName) && str(x.sourceUrl) && /^https?:\/\//.test(String(x.sourceUrl))
  );
}

export function fromLiveItem(l: LiveFeedInput): FeedCard {
  return {
    ...EMPTY,
    kind: "live",
    id: l.id,
    title: l.title,
    subtitle: l.creator.displayName || l.creator.username,
    image: l.creator.avatarUrl,
    href: l.href,
    viewerCount: Math.max(0, Number(l.viewerCount) || 0),
  };
}

export function fromNewsItem(n: NewsFeedInput): FeedCard {
  return {
    ...EMPTY,
    kind: "news",
    id: n.id,
    title: n.title,
    subtitle: n.categoryName || null,
    image: n.image,
    href: n.href,
    summary: n.summary || null,
    // Atribuirea sursei e obligatorie pe fiecare card de știri.
    attribution: n.sourceName,
    sourceUrl: n.sourceUrl,
  };
}
