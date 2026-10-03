/**
 * DELETE /api/admin/reviews/[id] — hard delete
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { withTransaction } from "@/lib/db";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam } from "@/lib/validation/params";
import { REVIEW_MODERATION_REASON } from "@/lib/admin/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireAdmin(req, "moderation");
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!isUuidParam(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const review = await withTransaction(async (q) => {
    const r = await q<{ user_id: string; product_id: string; rating: number }>(
      `SELECT user_id, product_id, rating FROM product_reviews WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [id]
    );
    const row = r.rows[0];
    if (!row) return null;
    await q(
      `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
       VALUES ($1, $2, 'delete', $3, $4::jsonb)`,
      [
        actor.userId,
        row.user_id,
        REVIEW_MODERATION_REASON.deleted,
        JSON.stringify({
          kind: "review",
          review_id: id,
          product_id: row.product_id,
          rating: row.rating,
        }),
      ]
    );
    await q(`DELETE FROM product_reviews WHERE id = $1`, [id]);
    return row;
  });
  if (!review) {
    return NextResponse.json({ error: "review_not_found" }, { status: 404 });
  }

  await logAdminAction({
    action: "review.delete",
    targetType: "product_review",
    targetId: id,
    details: { productId: review.product_id, rating: review.rating },
    req,
    actor,
  });
  return NextResponse.json({ ok: true, action: "delete" });
}
