import { describe, it, expect } from "vitest";
import { buildHomeRows } from "@/lib/movies/home";
import type { SeriesDto } from "@/lib/movies/types";

const dto = (id: string, genres: string[], isOfficial = false): SeriesDto => ({
  id, slug: id, title: id, synopsis: "", genres, coverUrl: null, posterUrl: null, trailerVideoId: null,
  freeEpisodes: 3, episodePriceCents: 500, seasonPriceCents: 0, seasonDiscountPct: 40, isAdult: false, episodeCount: 10,
  owner: { id: "o", name: "Swypik", isOfficial }, format: "series", attribution: null,
});

describe("movies/home", () => {
  it("construieste rândurile din catalogul propriu (trending/latest/watchlist), fără rânduri externe", () => {
    const trending = [dto("a", ["drama"], true), dto("b", ["drama"])];
    const rows = buildHomeRows({ trending, latest: [], continueWatching: [], watchlist: [] });

    const top10 = rows.find((r) => r.kind === "top10");
    const originals = rows.find((r) => r.kind === "originals");
    const genreRows = rows.filter((r) => r.kind === "genre");
    expect(top10?.items.map((s) => s.id)).toEqual(["a", "b"]);
    expect(originals?.items.map((s) => s.id)).toEqual(["a"]);
    expect(genreRows.length).toBeGreaterThan(0);
  });

  it("rândurile de gen sunt limitate la HOME_ROW_MAX", () => {
    const trending = Array.from({ length: 25 }, (_, i) => dto(`s${i}`, ["drama"]));
    const rows = buildHomeRows({ trending, latest: [], continueWatching: [], watchlist: [] });
    const dramaRow = rows.find((r) => r.kind === "genre" && r.genre === "drama");
    expect(dramaRow?.items.length).toBe(20);
  });
});
