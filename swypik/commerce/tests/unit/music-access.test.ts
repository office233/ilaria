import { describe, it, expect } from "vitest";
import { canStream, canBecomePremium } from "@/lib/music/access";
import { albumPriceCents, clampTrackPriceCents } from "@/lib/music/pricing";
import { MUSIC_TRACK_PRICE_MAX_CENTS, MUSIC_TRACK_PRICE_MIN_CENTS } from "@/lib/music/config";
import type { MusicViewer } from "@/lib/music/types";

const viewer = (o: Partial<MusicViewer> = {}): MusicViewer => ({ userId: "u1", isAdmin: false, unlockedTrackIds: new Set(), unlockedAlbumIds: new Set(), ...o });
const free = { id: "t1", artist_user_id: "a1", status: "published" as const, is_premium: false, album_id: null };
const prem = { id: "t2", artist_user_id: "a1", status: "published" as const, is_premium: true, album_id: "al1" };

describe("music/access", () => {
  it("piesele gratuite publicate se ascultă de oricine, cele nepublicate doar de artist/admin", () => {
    expect(canStream(viewer({ userId: null }), free)).toBe(true);
    expect(canStream(viewer({ userId: null }), { ...free, status: "draft" })).toBe(false);
    expect(canStream(viewer({ userId: "a1" }), { ...free, status: "draft" })).toBe(true);
    expect(canStream(viewer({ isAdmin: true }), { ...free, status: "draft" })).toBe(true);
  });
  it("premium: doar cu unlock pe piesă sau pe album, artist sau admin", () => {
    expect(canStream(viewer(), prem)).toBe(false);
    expect(canStream(viewer({ unlockedTrackIds: new Set(["t2"]) }), prem)).toBe(true);
    expect(canStream(viewer({ unlockedAlbumIds: new Set(["al1"]) }), prem)).toBe(true);
    expect(canStream(viewer({ userId: "a1" }), prem)).toBe(true);
  });
});

describe("music/pricing — RON (cenți, plată cu cardul)", () => {
  it("prețul albumului în cenți: cel setat, altfel suma pieselor cu preț cu discount; null = \"preț în curând\"", () => {
    const tracks = [{ is_premium: true, price_cents: 300 }, { is_premium: true, price_cents: 300 }, { is_premium: false, price_cents: null }];
    expect(albumPriceCents({ price_cents: 400 }, tracks, 30)).toBe(400);
    expect(albumPriceCents({ price_cents: null }, tracks, 30)).toBe(420);
    expect(albumPriceCents({ price_cents: null }, [{ is_premium: false, price_cents: null }], 30)).toBeNull();
  });
  it("limitele de preț (cenți RON)", () => {
    expect(clampTrackPriceCents(1)).toBe(MUSIC_TRACK_PRICE_MIN_CENTS);
    expect(clampTrackPriceCents(99_999_999)).toBe(MUSIC_TRACK_PRICE_MAX_CENTS);
  });
});

describe("music/access canBecomePremium", () => {
  it("o piesa publicata gratuit nu mai poate deveni premium (URL-ul public a fost deja difuzat)", () => {
    expect(canBecomePremium({ is_premium: false, published_at: "2026-09-22T00:00:00Z" })).toBe(false);
    expect(canBecomePremium({ is_premium: false, published_at: null })).toBe(true);
    expect(canBecomePremium({ is_premium: true, published_at: "2026-09-22T00:00:00Z" })).toBe(true);
  });
});
