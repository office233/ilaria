import { describe, it, expect } from "vitest";
import { MUSIC_STREAM_FILE, musicStreamTarget } from "@/lib/media/stream-path";

describe("media/stream-path musicStreamTarget", () => {
  const base = "https://cdn.example.com/music/raw/a1/t1/9f3c2a1b7e6d5c4a.m4a";
  it("segmentul constant intoarce chiar obiectul piesei (basename-ul nu pleaca niciodata la client)", () => {
    expect(MUSIC_STREAM_FILE).toBe("audio");
    expect(musicStreamTarget(base, MUSIC_STREAM_FILE)).toBe(base);
  });
  it("orice alta cale se rezolva relativ la directorul piesei si nu poate iesi din el", () => {
    expect(musicStreamTarget(base, "seg0.ts")).toBe("https://cdn.example.com/music/raw/a1/t1/seg0.ts");
    expect(musicStreamTarget(base, "../t2/x.m4a")).toBeNull();
    expect(musicStreamTarget(base, "/etc/passwd")).toBeNull();
    expect(musicStreamTarget(base, "")).toBeNull();
  });
});
