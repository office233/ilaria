import { describe, it, expect } from "vitest";
import { buildMusicObjectKey, isOwnedMusicKey } from "@/lib/storage/media-upload";
describe("storage/media-upload", () => {
  it("cheia sta sub music/raw/<artist>/<track>/ cu basename aleator generat pe server; doar extensiile audio permise", () => {
    const key = buildMusicObjectKey("a1", "t1", "Vara 2026.mp3");
    expect(key).toMatch(/^music\/raw\/a1\/t1\/[a-f0-9]{16}\.mp3$/);
    expect(buildMusicObjectKey("a1", "t1", "Vara 2026.mp3")).not.toBe(key);
    expect(buildMusicObjectKey("a1", "t1", "x.exe")).toMatch(/^music\/raw\/a1\/t1\/[a-f0-9]{16}\.m4a$/);
    expect(buildMusicObjectKey("../a1", "t1", "x.m4a").startsWith("music/raw/")).toBe(true);
  });
  it("un artist nu poate înregistra chei din alt prefix", () => {
    expect(isOwnedMusicKey("music/raw/a1/t1/x.m4a", "a1")).toBe(true);
    expect(isOwnedMusicKey("music/raw/a2/t1/x.m4a", "a1")).toBe(false);
    expect(isOwnedMusicKey("videos/raw/a1/t1/x.m4a", "a1")).toBe(false);
    expect(isOwnedMusicKey("music/raw/a1/../a2/x.m4a", "a1")).toBe(false);
  });
});
