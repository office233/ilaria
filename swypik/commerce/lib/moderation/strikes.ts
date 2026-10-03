/**
 * lib/moderation/strikes.ts — record moderation strikes against users.
 *
 * Every time a moderation helper (moderateText / labelVideo / labelProduct)
 * decides to REJECT or HIDE user-submitted content, the calling route should
 * call `recordStrike(...)` so the strike trigger updates the user's risk
 * score and may auto-suspend.
 *
 * Severities (DB CHECK 1..10):
 *   blocked   → 5  (two illegal posts ⇒ 7-day suspension)
 *   adult     → 3  (four adult hits ⇒ 7-day suspension)
 *   sensitive → 1  (ten sensitive hits ⇒ 7-day suspension)
 *   spam      → 2
 *   manual    → caller-supplied
 *
 * Never throws — moderation must never block the main response on a strike
 * write failure; we just log.
 */

import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type StrikeLabel = "blocked" | "adult" | "sensitive" | "spam" | "manual";
export type StrikeContext =
  | "comment"
  | "bio"
  | "display_name"
  | "post"
  | "video"
  | "product"
  | "search"
  | "report"
  | "manual";

export type StrikeInput = {
  userId: string;
  label: StrikeLabel;
  context: StrikeContext;
  /** override default severity (1..10) */
  severity?: number;
  reason?: string;
  refType?: string;
  refId?: string | number | null;
  reasons?: string[];
  signals?: Record<string, unknown>;
};

const DEFAULT_SEVERITY: Record<StrikeLabel, number> = {
  blocked: 5,
  adult: 3,
  sensitive: 1,
  spam: 2,
  manual: 1,
};

export async function recordStrike(input: StrikeInput): Promise<void> {
  if (!input.userId) return;
  const severity = Math.max(
    1,
    Math.min(10, Math.trunc(input.severity ?? DEFAULT_SEVERITY[input.label] ?? 1)),
  );
  try {
    await dbQuery(
      `INSERT INTO user_strikes
         (user_id, severity, label, context, reason, ref_type, ref_id, reasons, signals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb)`,
      [
        input.userId,
        severity,
        input.label,
        input.context,
        input.reason ?? null,
        input.refType ?? null,
        input.refId != null ? String(input.refId) : null,
        input.reasons && input.reasons.length > 0 ? input.reasons : null,
        JSON.stringify(input.signals ?? {}),
      ],
    );
  } catch (err) {
    // Never block the caller — log only.
    logger.warn(
      { err, userId: input.userId, label: input.label, ctx: input.context },
      "[strikes] failed to record strike",
    );
  }
}

export type SuspensionStatus = {
  suspended: boolean;
  until: string | null;
  reason: string | null;
  score: number;
};

/**
 * Returns suspension status for a user. Cheap (single index lookup).
 * Callers should reject the action with 403 when `suspended === true`.
 */
export async function getSuspensionStatus(
  userId: string | null | undefined,
): Promise<SuspensionStatus> {
  const empty: SuspensionStatus = { suspended: false, until: null, reason: null, score: 0 };
  if (!userId) return empty;
  try {
    const { rows } = await dbQuery<{
      status: string;
      suspended_until: string | null;
      suspension_reason: string | null;
      score: string | null;
    }>(
      `SELECT u.status,
              u.suspended_until,
              u.suspension_reason,
              COALESCE(r.score, 0)::text AS score
         FROM users u
         LEFT JOIN user_risk_scores r ON r.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return empty;
    const score = Number(row.score ?? 0);
    const until = row.suspended_until ? new Date(row.suspended_until) : null;
    const stillSuspended =
      row.status === "suspended" && (!until || until.getTime() > Date.now());
    return {
      suspended: stillSuspended,
      until: until ? until.toISOString() : null,
      reason: row.suspension_reason,
      score,
    };
  } catch (err) {
    logger.warn({ err, userId }, "[strikes] getSuspensionStatus failed");
    return empty;
  }
}

/**
 * Helper for route handlers — returns NextResponse-shaped object when
 * suspended, or null when the user may proceed. Routes call:
 *   const block = await suspensionGuard(userId);
 *   if (block) return NextResponse.json(block.body, { status: block.status });
 */
export async function suspensionGuard(
  userId: string | null | undefined,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const s = await getSuspensionStatus(userId);
  if (!s.suspended) return null;
  return {
    status: 403,
    body: {
      error: "Contul tău este suspendat pentru încălcări repetate ale regulilor.",
      suspended: true,
      until: s.until,
      reason: s.reason,
    },
  };
}
