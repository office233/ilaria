/**
 * Level math — pure, client-safe (no DB imports). The ONLY place XP turns
 * into a level; routes, profile badges and UI all go through here.
 */
import { LEVEL_XP_BASE, MAX_LEVEL } from "./config";

export type LevelProgress = {
  level: number;
  xp: number;
  /** Total XP at which the current level started. */
  levelStartXp: number;
  /** Total XP needed for the next level (null at MAX_LEVEL). */
  nextLevelXp: number | null;
  /** 0..1 progress inside the current level. */
  progress: number;
};

function sanitizeXp(xp: number): number {
  return Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
}

/** Total XP required to reach `level` (level 1 = 0 XP). */
export function xpForLevel(level: number): number {
  const l = Math.min(MAX_LEVEL, Math.max(1, Math.floor(level)));
  return LEVEL_XP_BASE * (l - 1) * (l - 1);
}

export function levelForXp(xp: number): number {
  const safe = sanitizeXp(xp);
  const raw = Math.floor(Math.sqrt(safe / LEVEL_XP_BASE)) + 1;
  // Guard float rounding at exact boundaries (e.g. sqrt(400/100) = 1.9999…).
  let level = Math.min(MAX_LEVEL, Math.max(1, raw));
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= safe) level++;
  while (level > 1 && xpForLevel(level) > safe) level--;
  return level;
}

export function levelProgress(xp: number): LevelProgress {
  const safe = sanitizeXp(xp);
  const level = levelForXp(safe);
  const levelStartXp = xpForLevel(level);
  if (level >= MAX_LEVEL) {
    return { level, xp: safe, levelStartXp, nextLevelXp: null, progress: 1 };
  }
  const nextLevelXp = xpForLevel(level + 1);
  const progress = (safe - levelStartXp) / (nextLevelXp - levelStartXp);
  return { level, xp: safe, levelStartXp, nextLevelXp, progress: Math.min(1, Math.max(0, progress)) };
}

/**
 * Daily-streak transition for trivia. `lastDay`/`today` are YYYY-MM-DD.
 * Same day → unchanged, consecutive day → +1, otherwise restart at 1.
 */
export function nextStreak(lastDay: string | null, today: string, current: number): number {
  if (!lastDay) return 1;
  if (lastDay === today) return Math.max(1, current);
  const diffDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / 86_400_000);
  return diffDays === 1 ? Math.max(0, current) + 1 : 1;
}

/** UTC day key used for daily XP refs and the daily cap (YYYY-MM-DD). */
export function xpDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
