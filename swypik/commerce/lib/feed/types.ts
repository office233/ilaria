/**
 * Contractul feed-ului unificat (Home / Explore) — client-safe, fără importuri
 * de server. Un răspuns de feed e o listă de `FeedItem`:
 *   - `video`: un clip (cu produs atașat opțional, badge de misiune, film etc.);
 *   - carduri de modul intercalate pe sloturi configurabile (lib/feed/interleave.ts):
 *     product | food | movie | music | stay | live | news.
 */
import type { MissionBadge } from "@/lib/missions/feed-badge";

export type FeedCreator = {
  id: string;
  name: string;
  username: string | null;
  verified: boolean;
  avatar: string | null;
};

/** Produsul atașat unui clip — doar dacă e eligibil (activ, sigur, cu preț și imagine). */
export type FeedVideoProduct = {
  id: string;
  name: string;
  title: string;
  image: string | null;
  image_url: string | null;
  priceCents: number | null;
  price: number | null;
  currency: string;
  /** 0 = livrare inclusă; null = se calculează la checkout. UI-ul traduce. */
  shippingCents: number | null;
  inventoryStatus: string | null;
  taxonomyNodeSlug: string | null;
  /** CTA direct pentru listări de verticală (ex. zboruri). */
  ctaUrl: string | null;
  vertical: string | null;
  linkPlacement: string;
  votes: { worthIt: number; notWorthIt: number; total: number; viewerVote: string | null };
};

export type FeedAudioTrack = {
  id: string;
  title: string | null;
  artist: string | null;
  image_url: string | null;
};

export type FeedMovieRef = { slug: string; title: string; episode: number; episodeCount: number };

export type FeedVideo = {
  id: string;
  /** Sursa preferată (HLS dacă există). */
  url: string | null;
  hlsUrl: string | null;
  /** MP4 de rezervă (preview.mp4 transcodat). */
  fallbackUrl: string | null;
  thumbnail: string | null;
  /** Secunde. */
  duration: number | null;
  creator: FeedCreator;
  description: string;
  likes: number;
  saves: number;
  shares: number;
  comments: number;
  viewer: { liked: boolean; saved: boolean; following: boolean };
  product: FeedVideoProduct | null;
  audioTrack: FeedAudioTrack | null;
  movie: FeedMovieRef | null;
  mission: MissionBadge | null;
  /** Limbile pentru care există subtitrare (/api/videos/[id]/captions?lang=xx&format=vtt). */
  captionLangs: string[];
};

export const FEED_CARD_KINDS = ["product", "food", "movie", "music", "stay", "live", "news"] as const;
export type FeedCardKind = (typeof FEED_CARD_KINDS)[number];

/** Card normalizat al unui modul; prețul se formatează în UI (limba viewerului). */
export type FeedCard = {
  kind: FeedCardKind;
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  /** Rută internă fără prefix de limbă. */
  href: string;
  price: { cents: number; currency: string; unit: "item" | "night" } | null;
  /** Rezumat (news). */
  summary: string | null;
  /** Atribuire obligatorie (licență CC / sursa știrii). */
  attribution: string | null;
  /** Link spre articolul original (news). */
  sourceUrl: string | null;
  /** Spectatori (live). */
  viewerCount: number | null;
  isFree: boolean | null;
};

export type FeedVideoItem = { kind: "video"; key: string; video: FeedVideo };
export type FeedCardItem = { kind: FeedCardKind; key: string; card: FeedCard };
export type FeedItem = FeedVideoItem | FeedCardItem;

export function isVideoItem(item: FeedItem): item is FeedVideoItem {
  return item.kind === "video";
}

export type FeedSource = "foryou" | "following";

export type FeedResponse = {
  items: FeedItem[];
  /** Compatibilitate (/api/v1/feed, seed SSR): doar clipurile din `items`. */
  videos: FeedVideo[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Id-ul cererii — logat în metadata impresiilor (evaluare off-policy). */
  requestId: string;
  ab: "a" | "b" | null;
};
