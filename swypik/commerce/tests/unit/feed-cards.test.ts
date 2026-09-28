import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));

import { fromLiveItem, fromModuleCard, fromNewsItem, fromStayItem, isLiveFeedInput, isNewsFeedInput } from "@/lib/feed/cards/adapters";
import { loadOptionalProducer } from "@/lib/feed/cards/optional";
import { loadCardPools } from "@/lib/feed/cards/providers";
import { toFoodCard, toProductCard } from "@/lib/feed/cards/commerce";
import type { ModuleFeedCard } from "@/lib/media/feed-card";
import type { FeedCard, FeedCardKind } from "@/lib/feed/types";

const movie: ModuleFeedCard = {
  kind: "movie_title", id: "m1", title: "Film", subtitle: "Studio", image: "/p.jpg", href: "/movies/film",
  media: null, isFree: true, genres: [], attribution: "CC BY Autor", licensedForCommercial: true, publishedAt: null,
};

describe("adaptoare de carduri", () => {
  it("Movies/Music: doar cu licență comercială", () => {
    expect(fromModuleCard(movie)).toMatchObject({ kind: "movie", attribution: "CC BY Autor", isFree: true });
    expect(fromModuleCard({ ...movie, kind: "music_track" })?.kind).toBe("music");
    expect(fromModuleCard({ ...movie, licensedForCommercial: false })).toBeNull();
  });

  it("Stays: preț pe noapte, formatat în UI", () => {
    const c = fromStayItem({
      kind: "stay", id: "s1", title: "Casa", image: "/i.jpg", href: "/stays/s1", priceLabel: "250 RON", priceCents: 25000,
      currency: "RON", priceUnit: "night", subtitle: "Brașov", rating: null, reviewsCount: 0, maxGuests: 2,
    });
    expect(c.price).toEqual({ cents: 25000, currency: "RON", unit: "night" });
  });

  it("Live/News: contract structural validat (modulele nu sunt importate static)", () => {
    const live = { kind: "live", id: "l1", href: "/live/l1", title: "Live", viewerCount: 12, startedAt: null, creator: { id: "c", username: "ana", displayName: null, avatarUrl: null } };
    expect(isLiveFeedInput(live)).toBe(true);
    expect(isLiveFeedInput({ ...live, href: "https://evil.test" })).toBe(false);
    expect(fromLiveItem(live as never)).toMatchObject({ kind: "live", subtitle: "ana", viewerCount: 12 });
    const news = { kind: "news" as const, id: "n1", title: "Știre", summary: "Rezumat", image: null, href: "/news/x", category: "biz", categoryName: "Business", sourceName: "BBC", sourceUrl: "https://bbc.test/a", publishedAt: "2026-09-26T00:00:00Z" };
    expect(isNewsFeedInput(news)).toBe(true);
    expect(isNewsFeedInput({ ...news, sourceUrl: "javascript:alert(1)" })).toBe(false);
    expect(fromNewsItem(news)).toMatchObject({ attribution: "BBC", sourceUrl: "https://bbc.test/a", summary: "Rezumat" });
  });

  it("produse/preparate fără imagine sau preț nu devin carduri", () => {
    expect(toProductCard({ id: "p", title: "T", image_url: null, price_cents: 100, currency: "RON" })).toBeNull();
    expect(toProductCard({ id: "p", title: "T", image_url: "/i", price_cents: "1990", currency: null })).toMatchObject({
      href: "/product/p", price: { cents: 1990, currency: "RON", unit: "item" },
    });
    expect(toFoodCard({ id: "f", name: "Pizza", image_url: "/i", price_cents: 0, currency: "RON", merchant_name: "M", merchant_slug: "m", merchant_id: "1" })).toBeNull();
    expect(toFoodCard({ id: "f", name: "Pizza", image_url: "/i", price_cents: 3500, currency: "RON", merchant_name: "M", merchant_slug: null, merchant_id: "1" })?.href).toBe("/food/1");
  });
});

describe("module opționale", () => {
  it("modul lipsă → null (tipul e sărit), export lipsă → null, producător valid → funcție", async () => {
    expect(await loadOptionalProducer("live", async () => { throw new Error("Cannot find module"); })).toBeNull();
    expect(await loadOptionalProducer("news", async () => ({ other: 1 }))).toBeNull();
    const fn = await loadOptionalProducer("news", async () => ({ getNewsFeedItems: async () => [] }));
    expect(typeof fn).toBe("function");
  });

  it("import real: live/news încă absente în acest arbore → null, fără excepție", async () => {
    const live = await loadOptionalProducer("live");
    expect(live === null || typeof live === "function").toBe(true);
  });
});

describe("loadCardPools", () => {
  it("cere fiecare tip cu limita dată (plafonată), un producător căzut nu strică restul", async () => {
    const seen: Record<string, number> = {};
    const make = (kind: FeedCardKind) => async (limit: number): Promise<FeedCard[]> => {
      seen[kind] = limit;
      if (kind === "food") throw new Error("db down");
      return [{ kind, id: "1", title: "t", subtitle: null, image: null, href: "/", price: null, summary: null, attribution: null, sourceUrl: null, viewerCount: null, isFree: null }];
    };
    const providers = Object.fromEntries(
      (["product", "food", "movie", "music", "stay", "live", "news"] as FeedCardKind[]).map((k) => [k, make(k)]),
    ) as Record<FeedCardKind, (limit: number) => Promise<FeedCard[]>>;
    const pools = await loadCardPools(new Map([["product", 3], ["food", 1], ["news", 500]]), { locale: "ro" }, providers);
    expect(pools.get("product")).toHaveLength(1);
    expect(pools.has("food")).toBe(false);
    expect(seen.news).toBe(50);
    expect(seen.movie).toBeUndefined();
  });
});
