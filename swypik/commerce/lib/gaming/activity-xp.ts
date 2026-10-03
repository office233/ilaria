/**
 * XP for real platform actions:
 *   - first_upload:   awarded directly when a video first goes live
 *                     (lib/video/publish-notify.ts → notifyFollowersOnce, the
 *                     single "now visible in the feed" point for publish,
 *                     admin approval and the scheduled-publish cron);
 *   - first_purchase: awarded directly on the first pending→paid order
 *                     transition (Stripe webhook, payments handler);
 *   - watch_daily:    reconciled on read (GET /api/gaming/profile) from
 *                     today's video_view events — views have no single hook.
 *
 * awardXp() claims (user, action, ref) first, so hooks, retries and replayed
 * webhooks can never double-grant. Hooks are best-effort: a gaming failure
 * never breaks publishing or payment processing.
 */
import { dbQuery } from "@/lib/db";
import { isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { XP_RULES, type XpAction } from "./config";
import { xpDay } from "./level-math";
import { awardXp } from "./xp";

export const ONCE_REF = "once";

export type MilestoneAction = Extract<XpAction, "first_upload" | "first_purchase">;

const MILESTONE_XP: Record<MilestoneAction, number> = {
  first_upload: XP_RULES.firstUpload.xp,
  first_purchase: XP_RULES.firstPurchase.xp,
};

/**
 * One-time milestone grant (idempotent on (user, action, "once")). Returns the
 * XP added (0 when the flag is off, already granted, or on any error).
 */
export async function awardMilestoneXp(userId: string | null | undefined, action: MilestoneAction): Promise<number> {
  if (!userId || !isEnabled("gaming")) return 0;
  try {
    const res = await awardXp(userId, action, ONCE_REF, MILESTONE_XP[action]);
    return res.awarded;
  } catch (err) {
    logger.warn({ err, userId, action }, "[gaming.xp] milestone award failed");
    return 0;
  }
}

export type ActivityGrant = { action: XpAction; ref: string; xp: number };

/** Pure: the watch_daily grant today's views justify, unless already claimed. */
export function pendingActivityGrants(facts: { views_today: number }, alreadyClaimed: ReadonlySet<string>, day: string): ActivityGrant[] {
  if (facts.views_today < XP_RULES.watchDaily.minViews) return [];
  const grant: ActivityGrant = { action: "watch_daily", ref: day, xp: XP_RULES.watchDaily.xp };
  return alreadyClaimed.has(`${grant.action}:${grant.ref}`) ? [] : [grant];
}

export async function syncActivityXp(userId: string): Promise<number> {
  const day = xpDay();
  try {
    const { rows: claimed } = await dbQuery<{ action: string; ref: string }>(
      `SELECT action, ref FROM gaming_xp_events WHERE user_id = $1 AND action = 'watch_daily' AND ref = $2`,
      [userId, day],
    );
    const claimedSet = new Set(claimed.map((r) => `${r.action}:${r.ref}`));
    if (claimedSet.has(`watch_daily:${day}`)) return 0;

    const { rows } = await dbQuery<{ views_today: number }>(
      `SELECT count(*)::int AS views_today FROM feed_events
        WHERE actor_user_id = $1 AND event_type = 'video_view' AND occurred_at >= $2::date`,
      [userId, day],
    );
    let total = 0;
    for (const grant of pendingActivityGrants({ views_today: Number(rows[0]?.views_today ?? 0) }, claimedSet, day)) {
      total += (await awardXp(userId, grant.action, grant.ref, grant.xp)).awarded;
    }
    return total;
  } catch (err) {
    // Best-effort: a failed reconcile must never break the profile read.
    logger.warn({ err, userId }, "[gaming.xp] activity sync failed");
    return 0;
  }
}
