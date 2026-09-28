import { describe, it, expect } from "vitest";
import { isFreeEpisode, canPlay, lockedEpisodeCount } from "@/lib/movies/access";
import type { ViewerContext } from "@/lib/movies/types";

const series = { free_episodes: 3, owner_user_id: "owner-1" };
const ep = (n: number, id = `ep-${n}`) => ({ id, episode_number: n });
const viewer = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  userId: "user-1", isAdmin: false, unlockedEpisodeIds: new Set(), hasSeasonUnlock: false, ...over,
});

describe("movies/access", () => {
  it("episoadele ≤ free_episodes sunt gratuite, restul nu", () => {
    expect(isFreeEpisode(series, ep(1))).toBe(true);
    expect(isFreeEpisode(series, ep(3))).toBe(true);
    expect(isFreeEpisode(series, ep(4))).toBe(false);
    expect(isFreeEpisode({ free_episodes: 0 }, ep(1))).toBe(false);
  });
  it("vizitatorul anonim vede doar episoadele gratuite", () => {
    expect(canPlay(viewer({ userId: null }), series, ep(2))).toBe(true);
    expect(canPlay(viewer({ userId: null }), series, ep(4))).toBe(false);
  });
  it("deblocarea per episod dă acces doar la acel episod", () => {
    const v = viewer({ unlockedEpisodeIds: new Set(["ep-5"]) });
    expect(canPlay(v, series, ep(5))).toBe(true);
    expect(canPlay(v, series, ep(6))).toBe(false);
  });
  it("sezonul deblocat dă acces la tot", () => {
    expect(canPlay(viewer({ hasSeasonUnlock: true }), series, ep(40))).toBe(true);
  });
  it("owner-ul și adminul văd tot", () => {
    expect(canPlay(viewer({ userId: "owner-1" }), series, ep(40))).toBe(true);
    expect(canPlay(viewer({ isAdmin: true }), series, ep(40))).toBe(true);
  });
  it("numără corect episoadele blocate", () => {
    expect(lockedEpisodeCount(series, 40)).toBe(37);
    expect(lockedEpisodeCount(series, 2)).toBe(0);
  });
});
