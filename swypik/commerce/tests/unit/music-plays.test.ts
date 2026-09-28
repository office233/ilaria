import { describe, it, expect, vi } from "vitest";
import { playDedupKey, shouldCountPlay } from "@/lib/music/plays";
describe("music/plays", () => {
  it("un play per (IP, piesă) în fereastra de dedup: doar primul SET NX contează", async () => {
    const seen = new Set<string>();
    const client = { set: vi.fn(async (key: string) => (seen.has(key) ? null : (seen.add(key), "OK"))) };
    expect(playDedupKey("1.2.3.4", "t1")).toBe("music:play:1.2.3.4:t1");
    expect(await shouldCountPlay(client, "1.2.3.4", "t1")).toBe(true);
    expect(await shouldCountPlay(client, "1.2.3.4", "t1")).toBe(false);
    expect(await shouldCountPlay(client, "1.2.3.4", "t2")).toBe(true);
    expect(client.set).toHaveBeenLastCalledWith("music:play:1.2.3.4:t2", "1", "EX", 600, "NX");
  });
});
