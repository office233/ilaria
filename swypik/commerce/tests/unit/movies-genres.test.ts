import { describe, it, expect } from "vitest";
import { MOVIE_GENRES, isMovieGenre, normalizeGenres, genreLabelKey } from "@/lib/movies/genres";
import { buildHomeRows } from "@/lib/movies/home";
import type { SeriesDto } from "@/lib/movies/types";

const dto = (id: string, genres: string[], isOfficial = false): SeriesDto => ({
  id, slug: id, title: id, synopsis: "", genres, coverUrl: null, posterUrl: null, trailerVideoId: null,
  freeEpisodes: 3, episodePriceCents: 500, seasonPriceCents: 0, seasonDiscountPct: 40, isAdult: false, episodeCount: 10,
  owner: { id: "o", name: "Swypik", isOfficial }, format: "series", attribution: null,
});

describe("movies/genres", () => {
  it("taxonomia este fixă, cu chei de traducere derivate din id", () => {
    expect(MOVIE_GENRES).toContain("drama");
    expect(isMovieGenre("drama")).toBe(true);
    expect(isMovieGenre("horror-x")).toBe(false);
    expect(genreLabelKey("kdrama")).toBe("genre_kdrama");
  });
  it("normalizează lista: elimină necunoscutele și duplicatele, păstrează ordinea", () => {
    expect(normalizeGenres(["drama", "Drama", "unknown", "romance", "drama"])).toEqual(["drama", "romance"]);
    expect(normalizeGenres([])).toEqual([]);
  });
});

describe("movies/home", () => {
  it("construiește rândurile: continuă, top 10, originale, noutăți, apoi câte un rând per gen cu conținut", () => {
    const trending = [dto("a", ["drama"], true), dto("b", ["romance"]), dto("c", ["drama", "comedy"])];
    const latest = [dto("c", ["drama", "comedy"]), dto("a", ["drama"], true)];
    const rows = buildHomeRows({ trending, latest, continueWatching: [], watchlist: [] });
    const kinds = rows.map((r) => r.kind);
    expect(kinds.slice(0, 3)).toEqual(["top10", "originals", "latest"]);
    const genreRows = rows.filter((r) => r.kind === "genre");
    expect(genreRows.map((r) => r.genre)).toEqual(["drama", "romance", "comedy"]);
    expect(genreRows[0].items.map((s) => s.id)).toEqual(["a", "c"]);
    expect(rows.find((r) => r.kind === "originals")?.items.map((s) => s.id)).toEqual(["a"]);
  });
  it("rândurile goale nu apar; continuă și lista mea vin primele când există", () => {
    const only = [dto("a", ["thriller"])];
    const rows = buildHomeRows({ trending: only, latest: only, continueWatching: [{ series: only[0], episodeNumber: 2, positionMs: 1, durationMs: 10 }], watchlist: only });
    expect(rows.map((r) => r.kind)).toEqual(["continue", "mylist", "top10", "latest", "genre"]);
  });
});
