import { describe, it, expect } from "vitest";
import { mapRadioStation, mergeWithCurated, streamFallbacks, type RawRadioStation } from "@/lib/audio/radio-browser";
import { CURATED_ROMANIAN_STATIONS } from "@/lib/audio/radio-curated";

const raw = (over: Partial<RawRadioStation>): RawRadioStation => ({
  stationuuid: "u1",
  name: "Test FM",
  url: "https://test.fm/stream.m3u",
  url_resolved: "https://edge.test.fm/live.aac",
  lastcheckok: 1,
  ...over,
});

describe("streamFallbacks", () => {
  it("doar https, fără duplicate și fără URL-ul principal", () => {
    expect(
      streamFallbacks("https://a/1", ["https://a/1", "http://b/2", "https://c/3", "https://c/3", null, undefined, " "]),
    ).toEqual(["https://c/3"]);
  });
});

describe("mapRadioStation", () => {
  it("redă url_resolved și pune url-ul declarat ca fallback", () => {
    const item = mapRadioStation(raw({}), { artist: "A", country: "RO", genre: "Radio" });
    expect(item.streamUrl).toBe("https://edge.test.fm/live.aac");
    expect(item.streamUrlFallbacks).toEqual(["https://test.fm/stream.m3u"]);
    expect(item.isLive).toBe(true);
  });

  it("fără fallback când url == url_resolved sau url e http", () => {
    expect(mapRadioStation(raw({ url: "https://edge.test.fm/live.aac" }), { artist: "A", country: "RO", genre: "R" }).streamUrlFallbacks).toBeUndefined();
    expect(mapRadioStation(raw({ url: "http://test.fm/x" }), { artist: "A", country: "RO", genre: "R" }).streamUrlFallbacks).toBeUndefined();
  });
});

describe("mergeWithCurated", () => {
  it("curatoriatele primele, îmbogățite cu fallback-urile și sigla din Radio-Browser", () => {
    const kiss = CURATED_ROMANIAN_STATIONS[0];
    const merged = mergeWithCurated([
      raw({ name: kiss.title, url_resolved: "https://rb.example/kiss.aac", favicon: "https://rb.example/kiss.png" }),
      raw({ stationuuid: "u2", name: "Alt Post" }),
      raw({ stationuuid: "u3", name: "Mort", lastcheckok: 0 }),
    ]);
    expect(merged.slice(0, CURATED_ROMANIAN_STATIONS.length).map((s) => s.id)).toEqual(CURATED_ROMANIAN_STATIONS.map((s) => s.id));
    expect(merged[0].streamUrl).toBe(kiss.streamUrl);
    expect(merged[0].streamUrlFallbacks).toContain("https://rb.example/kiss.aac");
    expect(merged[0].coverUrl).toBe("https://rb.example/kiss.png");
    expect(merged.map((s) => s.title)).toContain("Alt Post");
    expect(merged.map((s) => s.title)).not.toContain("Mort");
    // postul curatoriat nu e dublat de intrarea din API
    expect(merged.filter((s) => s.title === kiss.title)).toHaveLength(1);
  });
});
