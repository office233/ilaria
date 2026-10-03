import { describe, it, expect } from "vitest";
import { levelForXp, levelProgress, nextStreak, xpDay, xpForLevel } from "@/lib/gaming/level-math";
import { toLevelBadge } from "@/lib/gaming/level";
import { arcadeXp, triviaXp, MAX_LEVEL } from "@/lib/gaming/config";
import { isGameStartMessage } from "@/lib/gaming/postmessage";

describe("level math (single source of truth)", () => {
  it("xpForLevel follows 100 × (L-1)²", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(400);
    expect(xpForLevel(10)).toBe(8100);
  });

  it("levelForXp is exact at boundaries and monotonic", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(399)).toBe(2);
    expect(levelForXp(400)).toBe(3);
    expect(levelForXp(8100)).toBe(10);
    let prev = 1;
    for (let xp = 0; xp < 50_000; xp += 37) {
      const l = levelForXp(xp);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(xpForLevel(l)).toBeLessThanOrEqual(xp);
      prev = l;
    }
  });

  it("round-trips every level boundary", () => {
    for (let l = 1; l <= MAX_LEVEL; l++) expect(levelForXp(xpForLevel(l))).toBe(l);
  });

  it("sanitizes bad input and caps at MAX_LEVEL", () => {
    expect(levelForXp(-50)).toBe(1);
    expect(levelForXp(Number.NaN)).toBe(1);
    expect(levelForXp(1e12)).toBe(MAX_LEVEL);
    expect(levelProgress(1e12)).toMatchObject({ level: MAX_LEVEL, nextLevelXp: null, progress: 1 });
  });

  it("levelProgress reports progress inside the current level", () => {
    expect(levelProgress(250)).toEqual({ level: 2, xp: 250, levelStartXp: 100, nextLevelXp: 400, progress: 0.5 });
  });

  it("toLevelBadge turns a missing profile into level 1", () => {
    expect(toLevelBadge(undefined)).toMatchObject({ level: 1, xp: 0, triviaStreakDays: 0 });
    expect(toLevelBadge({ xp_points: "400", trivia_streak_days: 3 })).toMatchObject({ level: 3, xp: 400, triviaStreakDays: 3 });
  });
});

describe("XP rules", () => {
  it("arcade XP has a base, scales with score and is capped per round", () => {
    expect(arcadeXp(0)).toBe(10);
    expect(arcadeXp(500)).toBe(20);
    expect(arcadeXp(1_000_000)).toBe(100);
    expect(arcadeXp(-5)).toBe(10);
  });
  it("trivia XP is per correct answer, capped per day", () => {
    expect(triviaXp(0)).toBe(0);
    expect(triviaXp(3)).toBe(60);
    expect(triviaXp(50)).toBe(100);
  });
});

describe("streak + day helpers", () => {
  it("nextStreak: same day keeps, next day increments, gap restarts", () => {
    expect(nextStreak(null, "2026-09-26", 0)).toBe(1);
    expect(nextStreak("2026-09-26", "2026-09-26", 3)).toBe(3);
    expect(nextStreak("2026-09-25", "2026-09-26", 3)).toBe(4);
    expect(nextStreak("2026-09-23", "2026-09-26", 3)).toBe(1);
    expect(nextStreak("2026-02-28", "2026-03-01", 1)).toBe(2);
  });
  it("xpDay is the UTC date", () => {
    expect(xpDay(new Date("2026-09-26T23:59:59Z"))).toBe("2026-09-26");
  });
});

describe("postMessage: game restart", () => {
  it("accepts SWYPIK_GAME_START with a gameId only", () => {
    expect(isGameStartMessage({ type: "SWYPIK_GAME_START", gameId: "game_2048" })).toBe(true);
    expect(isGameStartMessage({ type: "SWYPIK_GAME_START" })).toBe(false);
    expect(isGameStartMessage({ type: "SWYPIK_GAME_OVER", gameId: "game_2048" })).toBe(false);
    expect(isGameStartMessage(null)).toBe(false);
  });
});
