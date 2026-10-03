/**
 * The single entry point for granting XP.
 *
 * Idempotency: every grant first claims (user, action, ref) in
 * gaming_xp_events (UNIQUE). A second call with the same triple — a retried
 * request, two concurrent submissions, a replayed webhook — claims nothing
 * and grants 0. Repeatable actions are also bounded by DAILY_XP_CAP via the
 * row-locked gaming_xp_daily counter. The level column is kept in sync with
 * lib/gaming/level-math.ts (never recomputed in SQL).
 */
import { withTransaction } from "@/lib/db";
import { DAILY_CAPPED_ACTIONS, DAILY_XP_CAP, type XpAction } from "./config";
import { levelForXp, xpDay } from "./level-math";

export type XpAward = {
  /** XP actually added (0 if duplicate or the daily cap is exhausted). */
  awarded: number;
  /** True when (user, action, ref) had already been claimed. */
  duplicate: boolean;
  /** Total XP after this grant (null when nothing changed). */
  totalXp: number | null;
};

export async function awardXp(userId: string, action: XpAction, ref: string, rawXp: number): Promise<XpAward> {
  const wanted = Math.max(0, Math.floor(Number.isFinite(rawXp) ? rawXp : 0));
  const day = xpDay();

  return withTransaction(async (q) => {
    const claim = await q<{ id: string }>(
      `INSERT INTO gaming_xp_events (user_id, action, ref, xp) VALUES ($1, $2, $3, 0)
       ON CONFLICT (user_id, action, ref) DO NOTHING
       RETURNING id`,
      [userId, action, ref],
    );
    const eventId = claim.rows[0]?.id;
    if (!eventId) return { awarded: 0, duplicate: true, totalXp: null };

    let granted = wanted;
    if (granted > 0 && DAILY_CAPPED_ACTIONS.has(action)) {
      await q(
        `INSERT INTO gaming_xp_daily (user_id, day, xp_earned) VALUES ($1, $2::date, 0)
         ON CONFLICT (user_id, day) DO NOTHING`,
        [userId, day],
      );
      const { rows } = await q<{ xp_earned: number }>(
        `SELECT xp_earned FROM gaming_xp_daily WHERE user_id = $1 AND day = $2::date FOR UPDATE`,
        [userId, day],
      );
      const earnedToday = Number(rows[0]?.xp_earned ?? 0);
      granted = Math.max(0, Math.min(granted, DAILY_XP_CAP - earnedToday));
      if (granted > 0) {
        await q(`UPDATE gaming_xp_daily SET xp_earned = xp_earned + $3 WHERE user_id = $1 AND day = $2::date`, [userId, day, granted]);
      }
    }
    if (granted === 0) return { awarded: 0, duplicate: false, totalXp: null };

    await q(`UPDATE gaming_xp_events SET xp = $2 WHERE id = $1`, [eventId, granted]);
    const { rows: profile } = await q<{ xp_points: string }>(
      `INSERT INTO gaming_user_profiles (user_id, xp_points) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET xp_points = gaming_user_profiles.xp_points + EXCLUDED.xp_points,
             updated_at = now()
       RETURNING xp_points::text`,
      [userId, granted],
    );
    const totalXp = Number(profile[0]?.xp_points ?? granted);
    await q(`UPDATE gaming_user_profiles SET level = $2 WHERE user_id = $1`, [userId, levelForXp(totalXp)]);
    return { awarded: granted, duplicate: false, totalXp };
  });
}
