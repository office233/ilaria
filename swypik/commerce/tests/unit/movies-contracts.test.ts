import { describe, it, expect, vi } from "vitest";

const queries: string[] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; }),
  withTransaction: vi.fn(),
}));

import { ownsReadyVideo } from "@/lib/movies/repository";
import { toSeriesDto } from "@/lib/movies/dto";
import { MOVIES_SEASON_DISCOUNT_PCT } from "@/lib/movies/config";
import type { MovieSeriesRow } from "@/lib/movies/types";

describe("movies/contracts", () => {
  it("un clip poate deveni episod doar dacă e aprobat la moderare (altfel aprobarea ulterioară îl face public)", async () => {
    queries.length = 0;
    await ownsReadyVideo("user-1", "video-1");
    expect(queries[0]).toMatch(/moderation_status = 'approved'/);
    expect(queries[0]).toMatch(/status = 'ready'/);
  });

  it("SeriesDto expune procentul de reducere al sezonului calculat pe server", () => {
    const series: MovieSeriesRow = {
      id: "s1", slug: "s", owner_user_id: "o", title: "T", synopsis: "", genres: [], language_code: "ro",
      cover_url: null, poster_url: null, trailer_video_id: null, status: "published", free_episodes: 3,
      episode_price_units: 500, episode_price_cents: 500, is_adult: false, license_note: null, format: "series", license_type: null, attribution_text: null,
      license_source_url: null, license_territories: [], license_expires_at: null, published_at: null, created_at: "", updated_at: "",
    };
    const dto = toSeriesDto(series, 40, null);
    expect(dto.seasonDiscountPct).toBe(MOVIES_SEASON_DISCOUNT_PCT);
    expect(dto.seasonPriceCents).toBe(Math.round(37 * 500 * (1 - MOVIES_SEASON_DISCOUNT_PCT / 100)));
  });
});
