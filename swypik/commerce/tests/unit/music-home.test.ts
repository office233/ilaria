import { describe, it, expect } from "vitest";
import { buildMusicHomeRows } from "@/lib/music/home";
import type { TrackDto } from "@/lib/music/types";
const track = (id: string, genre: string, official = false): TrackDto => ({
  id, slug: id, title: id, coverUrl: null, genre, durationMs: 1000, explicit: false, isPremium: false, priceCents: null, locked: false,
  allowReels: true, audioTrackId: null, albumId: null, trackNumber: null, plays7d: 0, liked: false,
  artist: { id: "a", slug: "a", stageName: "A", bio: "", avatarUrl: null, coverUrl: null, isOfficial: official },
});
describe("music/home", () => {
  it("top10 → originals → latest → liked → genuri în ordinea din top; fără rânduri goale", () => {
    const top = [track("1", "pop", true), track("2", "trap"), track("3", "pop")];
    const rows = buildMusicHomeRows({ top, latest: [track("3", "pop")], liked: [track("2", "trap")], playlists: [] });
    expect(rows.map((r) => r.kind)).toEqual(["top10", "originals", "latest", "liked", "genre", "genre"]);
    expect(rows.filter((r) => r.kind === "genre").map((r) => r.kind === "genre" && r.genre)).toEqual(["pop", "trap"]);
    expect(rows.find((r) => r.kind === "originals")?.items.map((t) => t.id)).toEqual(["1"]);
  });
  it("fără date ⇒ niciun rând", () => {
    expect(buildMusicHomeRows({ top: [], latest: [], liked: [], playlists: [] })).toEqual([]);
  });
});
