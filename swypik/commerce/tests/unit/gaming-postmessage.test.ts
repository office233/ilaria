import { describe, it, expect } from "vitest";
import { isSafeGameUrl, isGameOverMessage } from "@/lib/gaming/postmessage";

describe("gaming/postmessage isSafeGameUrl", () => {
  it("accepts same-origin /games/ paths", () => {
    expect(isSafeGameUrl("/games/2048/index.html")).toBe(true);
    expect(isSafeGameUrl("/games/flappy/index.html")).toBe(true);
  });

  it("rejects external / absolute origins", () => {
    expect(isSafeGameUrl("https://evil.example.com/games/2048/index.html")).toBe(false);
    expect(isSafeGameUrl("//evil.example.com/games/2048/index.html")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isSafeGameUrl("/games/../admin/index.html")).toBe(false);
  });

  it("rejects paths outside /games/", () => {
    expect(isSafeGameUrl("/account/index.html")).toBe(false);
    expect(isSafeGameUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isSafeGameUrl(undefined as unknown as string)).toBe(false);
  });
});

describe("gaming/postmessage isGameOverMessage", () => {
  it("accepts a well-shaped message", () => {
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", gameId: "game_2048", score: 120, durationMs: 5000 })).toBe(true);
  });

  it("rejects wrong type", () => {
    expect(isGameOverMessage({ type: "SWYPIK_SCORE_UPDATE", gameId: "game_2048", score: 120 })).toBe(false);
  });

  it("rejects missing/invalid fields", () => {
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", score: 120 })).toBe(false);
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", gameId: "game_2048", score: "120" })).toBe(false);
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", gameId: "", score: 120 })).toBe(false);
    expect(isGameOverMessage(null)).toBe(false);
    expect(isGameOverMessage("string")).toBe(false);
    expect(isGameOverMessage(42)).toBe(false);
  });

  it("rejects non-finite scores", () => {
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", gameId: "game_2048", score: Infinity })).toBe(false);
    expect(isGameOverMessage({ type: "SWYPIK_GAME_OVER", gameId: "game_2048", score: NaN })).toBe(false);
  });
});
