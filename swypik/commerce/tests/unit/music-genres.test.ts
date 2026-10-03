import { describe, it, expect } from "vitest";
import { MUSIC_GENRES, isMusicGenre, normalizeMusicGenres, musicGenreLabelKey } from "@/lib/music/genres";

describe("music/genres", () => {
  it("taxonomie fixa cu chei de traducere", () => {
    expect(MUSIC_GENRES).toContain("manele");
    expect(isMusicGenre("pop")).toBe(true);
    expect(isMusicGenre("polka")).toBe(false);
    expect(musicGenreLabelKey("hiphop")).toBe("genre_hiphop");
  });
  it("normalizeaza: necunoscute afara, fara duplicate, ordine pastrata", () => {
    expect(normalizeMusicGenres(["Pop", "pop", "x", "trap"])).toEqual(["pop", "trap"]);
  });
});
