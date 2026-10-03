import { describe, it, expect } from "vitest";
import { episodeMediaDir, resolveEpisodeMediaUrl, toProxyPath, mediaBasename } from "@/lib/media/stream-path";

const playback = "https://media.example.com/videos/hls/abc-123/master.m3u8";

describe("movies/stream-path", () => {
  it("directorul episodului este prefixul playback_url până la ultimul /", () => {
    expect(episodeMediaDir(playback)).toBe("https://media.example.com/videos/hls/abc-123/");
    expect(mediaBasename(playback)).toBe("master.m3u8");
  });
  it("o cale relativă se rezolvă DOAR în interiorul directorului episodului", () => {
    expect(resolveEpisodeMediaUrl(playback, "master.m3u8")).toBe(playback);
    expect(resolveEpisodeMediaUrl(playback, "seg/seg0.ts")).toBe("https://media.example.com/videos/hls/abc-123/seg/seg0.ts");
  });
  it("respinge traversarea (.., %2e%2e, cale absolută, alt host)", () => {
    expect(resolveEpisodeMediaUrl(playback, "../other-video/master.m3u8")).toBeNull();
    expect(resolveEpisodeMediaUrl(playback, "%2e%2e/other-video/master.m3u8")).toBeNull();
    expect(resolveEpisodeMediaUrl(playback, "/videos/hls/other/master.m3u8")).toBeNull();
    expect(resolveEpisodeMediaUrl(playback, "https://evil.com/x.ts")).toBeNull();
    expect(resolveEpisodeMediaUrl(playback, "")).toBeNull();
  });
  it("URL-urile absolute din playlist devin căi de proxy relative la episod; cele din afara directorului rămân neatinse", () => {
    expect(toProxyPath("TOKEN", "https://media.example.com/videos/hls/abc-123/seg0.ts", playback)).toBe("/api/movies/stream/TOKEN/seg0.ts");
    expect(toProxyPath("TOKEN", "https://media.example.com/videos/hls/abc-123/v1/seg0.ts", playback)).toBe("/api/movies/stream/TOKEN/v1/seg0.ts");
    expect(toProxyPath("TOKEN", "https://media.example.com/videos/hls/zzz/seg0.ts", playback)).toBe("https://media.example.com/videos/hls/zzz/seg0.ts");
  });
});
