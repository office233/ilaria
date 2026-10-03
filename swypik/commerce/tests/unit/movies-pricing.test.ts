import { describe, it, expect } from "vitest";
import { seasonPriceCents, creatorShareCents, clampEpisodePriceCents } from "@/lib/movies/pricing";
import { SWYPIK_OFFICIAL_ID } from "@/lib/config/accounts";
import { MOVIES_EPISODE_PRICE_MAX_CENTS, MOVIES_EPISODE_PRICE_MIN_CENTS } from "@/lib/movies/config";

describe("movies/pricing — RON (cenți, plată cu cardul)", () => {
  it("prețul sezonului = episoade blocate × preț × (1 − discount)", () => {
    // 40 episoade, 3 gratuite → 37 × 500 = 18500 → −40 % = 11100
    expect(seasonPriceCents({ free_episodes: 3, episode_price_cents: 500 }, 40, 40)).toBe(11100);
    expect(seasonPriceCents({ free_episodes: 3, episode_price_cents: 500 }, 3, 40)).toBe(0);
  });
  it("preț RON nesetat (null) ⇒ prețul sezonului e null (\"preț în curând\")", () => {
    expect(seasonPriceCents({ free_episodes: 3, episode_price_cents: null }, 40, 40)).toBeNull();
  });
  it("cota creatorului = 70 % rotunjit în jos; 0 pentru contul oficial și pentru self-unlock", () => {
    expect(creatorShareCents(500, "owner-1", "viewer-1", 7000)).toBe(350);
    expect(creatorShareCents(333, "owner-1", "viewer-1", 7000)).toBe(233);
    expect(creatorShareCents(500, SWYPIK_OFFICIAL_ID, "viewer-1", 7000)).toBe(0);
    expect(creatorShareCents(500, "owner-1", "owner-1", 7000)).toBe(0);
    expect(creatorShareCents(0, "owner-1", "viewer-1", 7000)).toBe(0);
  });
  it("prețul per episod (cenți RON) se limitează la intervalul configurat", () => {
    expect(clampEpisodePriceCents(1)).toBe(MOVIES_EPISODE_PRICE_MIN_CENTS);
    expect(clampEpisodePriceCents(10_000_000)).toBe(MOVIES_EPISODE_PRICE_MAX_CENTS);
    expect(clampEpisodePriceCents(750.7)).toBe(750);
  });
});
