/**
 * Level badge data for profiles (server-side). The math lives in
 * ./level-math (client-safe); this module adds the DB reads.
 *
 *   const badge = await getLevelBadge(userId);        // one profile
 *   const badges = await getLevelBadges(userIds);     // lists (comments, leaderboards)
 *
 * Render with components/gaming/LevelBadge.tsx.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { levelProgress, type LevelProgress } from "./level-math";

export { levelForXp, xpForLevel, levelProgress, nextStreak, xpDay } from "./level-math";
export type { LevelProgress } from "./level-math";

export type LevelBadge = LevelProgress & { triviaStreakDays: number };

type ProfileRow = { user_id: string; xp_points: string | number | null; trivia_streak_days: number | null };

export function toLevelBadge(row: Pick<ProfileRow, "xp_points" | "trivia_streak_days"> | null | undefined): LevelBadge {
  return {
    ...levelProgress(Number(row?.xp_points ?? 0)),
    triviaStreakDays: Number(row?.trivia_streak_days ?? 0),
  };
}

export async function getLevelBadge(userId: string): Promise<LevelBadge> {
  const { rows } = await dbQuery<ProfileRow>(
    `SELECT user_id, xp_points::text AS xp_points, trivia_streak_days FROM gaming_user_profiles WHERE user_id = $1`,
    [userId],
  );
  return toLevelBadge(rows[0]);
}

/**
 * Badge-ul din antetul profilului public: `null` când modulul gaming e OFF
 * (fără citire din DB) sau la eroare — profilul nu cade din cauza nivelului.
 */
export async function getProfileLevelBadge(userId: string): Promise<LevelBadge | null> {
  if (!isEnabled("gaming")) return null;
  try {
    return await getLevelBadge(userId);
  } catch (err) {
    logger.warn({ err, userId }, "[gaming] profile level badge failed");
    return null;
  }
}

/** Batch variant; users without a gaming profile get the level-1 badge. */
export async function getLevelBadges(userIds: string[]): Promise<Map<string, LevelBadge>> {
  const ids = Array.from(new Set(userIds)).slice(0, 200);
  const out = new Map<string, LevelBadge>();
  if (ids.length === 0) return out;
  const { rows } = await dbQuery<ProfileRow>(
    `SELECT user_id::text AS user_id, xp_points::text AS xp_points, trivia_streak_days
       FROM gaming_user_profiles WHERE user_id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  for (const id of ids) out.set(id, toLevelBadge(byId.get(id)));
  return out;
}
