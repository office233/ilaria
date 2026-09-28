import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cap-coadă: producătorii reali ai modulelor (mock-uiți la sursă) → registrul
 * CARD_PROVIDERS → cererea din sloturile implicite → interleave. Fiecare tip
 * apare în feed când producătorul lui are itemi și dispare când flag-ul e OFF
 * (sau slotul e dezactivat) — fără să strice pozițiile clipurilor.
 */

const flags = vi.hoisted(() => ({
  server: { movies: true, music: true, news: true } as Record<string, boolean>,
  client: { food: true, stays: true, live: true } as Record<string, boolean>,
}));
const calls = vi.hoisted(() => ({ n: {} as Record<string, number> }));
const hit = (k: string) => {
  calls.n[k] = (calls.n[k] ?? 0) + 1;
};

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: (f: string) => flags.server[f] ?? false }));
vi.mock("@/lib/feature-flags-client", () => ({ isEnabledClient: (f: string) => flags.client[f] ?? false }));

const moduleCard = (kind: "movie_title" | "music_track", id: string) => ({
  kind, id, title: id, subtitle: null, image: "/i.jpg", href: `/x/${id}`, media: null, isFree: true, genres: [],
  attribution: "CC BY", licensedForCommercial: true, publishedAt: null,
});
const simpleCard = (kind: "product" | "food", id: string) => ({
  kind, id, title: id, subtitle: null, image: "/i.jpg", href: `/x/${id}`, price: { cents: 100, currency: "RON", unit: "item" as const },
  summary: null, attribution: null, sourceUrl: null, viewerCount: null, isFree: null,
});

vi.mock("@/lib/movies/feed-items", () => ({ getMovieFeedItems: async () => (hit("movie"), [moduleCard("movie_title", "m1")]) }));
vi.mock("@/lib/music/feed-items", () => ({ getMusicFeedItems: async () => (hit("music"), [moduleCard("music_track", "t1")]) }));
vi.mock("@/lib/stays/feed-items", () => ({
  getStaysFeedItems: async () => (hit("stay"), [{
    kind: "stay", id: "s1", title: "Casa", image: "/i.jpg", href: "/stays/s1", priceLabel: "250 RON", priceCents: 25000,
    currency: "RON", priceUnit: "night", subtitle: "Brașov", rating: null, reviewsCount: 0, maxGuests: 2,
  }]),
}));
vi.mock("@/lib/live/feed-items", () => ({
  getLiveFeedItems: async () => (hit("live"), [{
    kind: "live", id: "l1", href: "/live/l1", title: "Live", viewerCount: 3, startedAt: null,
    creator: { id: "c", username: "ana", displayName: null, avatarUrl: null },
  }]),
}));
vi.mock("@/lib/news/feed-items", () => ({
  getNewsFeedItems: async () => (hit("news"), [{
    kind: "news", id: "n1", title: "Știre", summary: "Rezumat", image: null, href: "/news/x", category: "biz",
    categoryName: "Business", sourceName: "BBC", sourceUrl: "https://bbc.test/a", publishedAt: "2026-09-26T00:00:00Z",
  }]),
}));
vi.mock("@/lib/feed/cards/commerce", () => ({
  getShopFeedCards: async () => (hit("product"), [simpleCard("product", "p1"), simpleCard("product", "p2"), simpleCard("product", "p3")]),
  getFoodFeedCards: async () => (hit("food"), [simpleCard("food", "f1")]),
}));

import { loadCardPools } from "@/lib/feed/cards/providers";
import { cardDemand, interleave } from "@/lib/feed/interleave";
import { mergeSlotRules, type SlotRule } from "@/lib/feed/slots";
import type { FeedCardKind, FeedVideoItem } from "@/lib/feed/types";

const videos: FeedVideoItem[] = Array.from({ length: 30 }, (_, i) => ({
  kind: "video", key: `video:${i}`, video: { id: `v${i}` } as FeedVideoItem["video"],
}));

const ALL: FeedCardKind[] = ["product", "food", "movie", "music", "stay", "live", "news"];
/** Câte un slot per tip, necoliziuni (pozițiile 1,3,5,…): testăm producătorii, nu cadența implicită. */
const RULES: SlotRule[] = ALL.map((kind, i) => ({ kind, every: 100, first: 1 + 2 * i, maxPerPage: 1, enabled: true, priority: i }));

async function feedKinds(rules: SlotRule[] = RULES) {
  const maxCards = rules.reduce((n, r) => n + (r.enabled ? r.maxPerPage : 0), 0);
  const demand = cardDemand(rules, 0, videos.length + maxCards);
  const pools = await loadCardPools(demand, { locale: "ro" });
  const { items } = interleave({ videos, rules, pools, startPos: 0 });
  return { items, kinds: new Set(items.filter((i) => i.kind !== "video").map((i) => i.kind)) };
}

beforeEach(() => {
  flags.server = { movies: true, music: true, news: true };
  flags.client = { food: true, stays: true, live: true };
  calls.n = {};
});

describe("carduri de modul în feed, cap-coadă", () => {
  it("toate modulele apar când producătorii au itemi (stays via lib/stays/feed-items, live/news via optional.ts)", async () => {
    const { items, kinds } = await feedKinds();
    for (const k of ALL) expect(kinds.has(k), k).toBe(true);
    expect(items[0].kind).toBe("video");
    expect(items.filter((i) => i.kind === "video")).toHaveLength(videos.length);
    const stay = items.find((i) => i.kind === "stay");
    expect(stay && "card" in stay ? stay.card.price : null).toEqual({ cents: 25000, currency: "RON", unit: "night" });
  });

  it.each([
    ["movie", (): void => { flags.server.movies = false; }],
    ["music", (): void => { flags.server.music = false; }],
    ["news", (): void => { flags.server.news = false; }],
    ["stay", (): void => { flags.client.stays = false; }],
    ["live", (): void => { flags.client.live = false; }],
    ["food", (): void => { flags.client.food = false; }],
  ] as Array<[FeedCardKind, () => void]>)("%s: flag OFF → tipul lipsește, producătorul nu e apelat, restul rămân", async (kind, off) => {
    off();
    const { items, kinds } = await feedKinds();
    expect(kinds.has(kind)).toBe(false);
    expect(calls.n[kind] ?? 0).toBe(0);
    expect(items.filter((i) => i.kind === "video")).toHaveLength(videos.length);
    for (const other of ALL.filter((k) => k !== kind)) expect(kinds.has(other), other).toBe(true);
  });

  it("slot dezactivat (FEED_SLOT_STAY=off) → nici măcar nu se cere", async () => {
    expect(mergeSlotRules([], { FEED_SLOT_STAY: "off" } as unknown as NodeJS.ProcessEnv).find((r) => r.kind === "stay")?.enabled).toBe(false);
    const rules = RULES.map((r) => (r.kind === "stay" ? { ...r, enabled: false } : r));
    const { kinds } = await feedKinds(rules);
    expect(kinds.has("stay")).toBe(false);
    expect(calls.n.stay ?? 0).toBe(0);
  });
});
