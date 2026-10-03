/**
 * User-level fraud block helpers.
 * Stored in users.metadata.fraud_user_block (jsonb) for simple deploys.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyOps } from "@/lib/ops/alerts";
import { APP_URL } from "@/lib/app-url";

export type UserFraudBlock = {
  blocked: boolean;
  blocked_at?: string;
  reason?: string;
  blocked_by?: "auto" | "admin";
  trigger_order_ids?: string[];
  unblocked_at?: string;
  unblock_reason?: string;
};

const AUTO_BLOCK_THRESHOLD = 3;          // ≥3 flagged orders in window
const AUTO_BLOCK_WINDOW_DAYS = 30;
const AUTO_BLOCK_MIN_SCORE = 50;          // count only review-level+

export async function isUserFraudBlocked(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { rows } = await dbQuery<{ blocked: boolean | null }>(
    `SELECT (metadata->'fraud_user_block'->>'blocked')::boolean AS blocked
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0]?.blocked === true;
}

/**
 * Check whether this user just crossed the auto-block threshold and apply the block.
 * Idempotent: if already blocked, no-ops. Called after each scored order.
 */
export async function maybeAutoBlockUser(args: {
  userId: string;
  triggeringOrderId: string;
  currentScore: number;
}): Promise<{ blocked: boolean; reason?: string }> {
  if (!args.userId) return { blocked: false };
  if (args.currentScore < AUTO_BLOCK_MIN_SCORE) return { blocked: false };

  // Already blocked? No-op.
  if (await isUserFraudBlocked(args.userId)) return { blocked: false };

  // Count flagged orders in window — uses fraud_score in metadata set by webhook.
  const { rows } = await dbQuery<{ flagged: number; order_ids: string[] }>(
    `SELECT COUNT(*)::int AS flagged,
            ARRAY_AGG(id) AS order_ids
       FROM commerce_orders
      WHERE buyer_user_id = $1
        AND created_at > now() - interval '${AUTO_BLOCK_WINDOW_DAYS} days'
        AND COALESCE((metadata->>'fraud_score')::int, 0) >= ${AUTO_BLOCK_MIN_SCORE}`,
    [args.userId],
  );
  const flagged = rows[0]?.flagged || 0;
  const orderIds = rows[0]?.order_ids || [];
  if (flagged < AUTO_BLOCK_THRESHOLD) return { blocked: false };

  const reason = `Auto-block: ${flagged} comenzi cu risc ≥${AUTO_BLOCK_MIN_SCORE} în ultimele ${AUTO_BLOCK_WINDOW_DAYS}d`;
  const block: UserFraudBlock = {
    blocked: true,
    blocked_at: new Date().toISOString(),
    reason,
    blocked_by: "auto",
    trigger_order_ids: orderIds.map(String),
  };

  await dbQuery(
    `UPDATE users SET metadata = metadata || jsonb_build_object('fraud_user_block', $1::jsonb)
      WHERE id = $2`,
    [JSON.stringify(block), args.userId],
  );

  await dbQuery(
    `INSERT INTO user_fraud_decisions (user_id, action, reason, trigger_order_ids, score_at_decision, decided_by)
     VALUES ($1, 'auto_block', $2, $3::uuid[], $4, 'system')`,
    [args.userId, reason, orderIds, args.currentScore],
  );

  logger.warn({ userId: args.userId, flagged, orderIds }, "[fraud-user-block] auto-blocked");

  await notifyOps({
    key: `user_auto_block:${args.userId}`,
    severity: "critical",
    title: `User AUTO-BLOCK ${args.userId.slice(0, 8)} — ${flagged} comenzi flagged`,
    detail: reason,
    link: `${APP_URL}/admin/risk?status=paid`,
    payload: { userId: args.userId, flagged, orderIds },
    cooldownMin: 60,
  }).catch((e) => logger.warn({ err: e }, "[fraud-user-block] notify failed"));

  return { blocked: true, reason };
}

export async function setUserFraudBlock(args: {
  userId: string;
  blocked: boolean;
  reason: string;
  by: "admin";
}): Promise<void> {
  if (args.blocked) {
    const block: UserFraudBlock = {
      blocked: true,
      blocked_at: new Date().toISOString(),
      reason: args.reason,
      blocked_by: "admin",
    };
    await dbQuery(
      `UPDATE users SET metadata = metadata || jsonb_build_object('fraud_user_block', $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify(block), args.userId],
    );
    await dbQuery(
      `INSERT INTO user_fraud_decisions (user_id, action, reason, decided_by)
       VALUES ($1, 'admin_block', $2, 'admin')`,
      [args.userId, args.reason],
    );
  } else {
    // Mark as unblocked but keep history (replace block object, set blocked=false + unblock fields)
    const unblock: UserFraudBlock = {
      blocked: false,
      unblocked_at: new Date().toISOString(),
      unblock_reason: args.reason,
    };
    await dbQuery(
      `UPDATE users SET metadata = metadata || jsonb_build_object('fraud_user_block', $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify(unblock), args.userId],
    );
    await dbQuery(
      `INSERT INTO user_fraud_decisions (user_id, action, reason, decided_by)
       VALUES ($1, 'admin_unblock', $2, 'admin')`,
      [args.userId, args.reason],
    );
  }

  await notifyOps({
    key: `user_${args.blocked ? "block" : "unblock"}:${args.userId}`,
    severity: args.blocked ? "warning" : "info",
    title: `User ${args.blocked ? "BLOCK" : "UNBLOCK"} ${args.userId.slice(0, 8)}`,
    detail: args.reason,
    link: `${APP_URL}/admin/risk?status=paid`,
    payload: { userId: args.userId, blocked: args.blocked },
    cooldownMin: 1,
  }).catch((e) => logger.warn({ err: e }, "[fraud-user-block] notify failed"));
}
