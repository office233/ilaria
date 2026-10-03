/**
 * POST /api/admin/users/[id]/unsuspend — ridică suspendarea. Permisiune: users.manage.
 */
import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "users.manage");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  let found: boolean;
  try {
    found = await withTransaction(async (q) => {
      const res = await q(
        `UPDATE users SET suspended_until = NULL, suspension_reason = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      if (res.rowCount === 0) return false;
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
         VALUES ($1, $2, 'restore', 'unsuspend', $3::jsonb)`,
        [actor.userId, id, JSON.stringify({ source: "admin_users_page" })],
      );
      return true;
    });
  } catch (err) {
    logger.error({ err, userId: id }, "[admin/users/unsuspend] failed");
    return NextResponse.json({ error: "unsuspend_failed" }, { status: 500 });
  }
  if (!found) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  await logAdminAction({ action: "user.unsuspend", targetType: "user", targetId: id, actor, req });
  return NextResponse.json({ ok: true });
}
