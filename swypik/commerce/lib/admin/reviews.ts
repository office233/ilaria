/**
 * Moderarea recenziilor de produs din consola de admin.
 *
 * `moderation_actions.reason` stochează coduri stabile (nu propoziții într-o
 * limbă anume) — UI-ul le traduce la afișare. Motivul liber scris de
 * moderator (hide) se păstrează ca atare.
 */
import { withTransaction } from "@/lib/db";
import type { AdminActor } from "@/lib/admin/guard";

export const REVIEW_MODERATION_REASON = {
  deleted: "review_deleted_by_moderator",
  hidden: "review_hidden_by_moderator",
  restored: "review_restored_by_moderator",
} as const;

export type ReviewVisibilityResult =
  | { status: "not_found" }
  | { status: "unchanged"; productId: string }
  | { status: "changed"; productId: string };

/**
 * Ascunde / reafișează o recenzie într-o singură tranzacție (UPDATE +
 * rândul din moderation_actions). Tranziția e condiționată de starea curentă:
 * un al doilea „hide” pe o recenzie deja ascunsă nu mai scrie încă o acțiune.
 */
export async function setReviewHidden(opts: {
  reviewId: string;
  hidden: boolean;
  reason: string | null;
  actor: AdminActor;
}): Promise<ReviewVisibilityResult> {
  const { reviewId, hidden, reason, actor } = opts;
  return withTransaction(async (q) => {
    const r = await q<{ user_id: string; product_id: string; is_hidden: boolean }>(
      `SELECT user_id, product_id, is_hidden FROM product_reviews WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [reviewId],
    );
    const row = r.rows[0];
    if (!row) return { status: "not_found" } as const;

    const upd = await q(
      `UPDATE product_reviews SET is_hidden = $2, updated_at = NOW()
        WHERE id = $1 AND is_hidden IS DISTINCT FROM $2`,
      [reviewId, hidden],
    );
    if (upd.rowCount === 0) return { status: "unchanged", productId: row.product_id } as const;

    await q(
      `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        actor.userId,
        row.user_id,
        hidden ? "hide" : "restore",
        reason || (hidden ? REVIEW_MODERATION_REASON.hidden : REVIEW_MODERATION_REASON.restored),
        JSON.stringify({ kind: "review", review_id: reviewId, product_id: row.product_id }),
      ],
    );
    return { status: "changed", productId: row.product_id } as const;
  });
}
