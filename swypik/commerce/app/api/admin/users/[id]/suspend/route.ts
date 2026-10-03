/**
 * POST /api/admin/users/[id]/suspend — body { days, reason }. Permisiune: users.manage.
 * Suspendare + revocarea tuturor sesiunilor (cumpărător, seller) într-o tranzacție.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/admin/guard";
import { logAdminAction } from "@/lib/security/admin-audit";
import { notifyLocalized } from "@/lib/notifications/localized";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 36500 zile = „permanent” în UI (ban_user). */
const PERMANENT_DAYS = 36500;

const Body = z.object({
  days: z.coerce.number().int().min(1).max(PERMANENT_DAYS),
  reason: z.string().trim().min(1).max(500),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "users.manage");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return NextResponse.json({ error: field === "reason" ? "reason_required" : "invalid_days" }, { status: 400 });
  }
  const { days, reason } = parsed.data;

  let outcome: "ok" | "user_not_found" | "cannot_suspend_admin";
  try {
    outcome = await withTransaction(async (q) => {
      const { rows } = await q<{ role: string }>(`SELECT role FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return "user_not_found" as const;
      if (rows[0].role === "admin") return "cannot_suspend_admin" as const;

      await q(
        `UPDATE users SET suspended_until = now() + ($2::int * interval '1 day'), suspension_reason = $3, updated_at = now()
          WHERE id = $1`,
        [id, days, reason],
      );
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, ends_at, metadata)
         VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 day'), $6::jsonb)`,
        [actor.userId, id, days >= PERMANENT_DAYS ? "ban_user" : "suspend_user", reason, days, JSON.stringify({ source: "admin_users_page", days })],
      );
      // Revocarea sesiunilor face parte din suspendare: dacă pică, se anulează tot.
      await q(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await q(
        `DELETE FROM seller_sessions WHERE seller_id IN (
           SELECT s.id FROM sellers s JOIN users u ON lower(u.email) = lower(s.email) WHERE u.id = $1)`,
        [id],
      );
      return "ok" as const;
    });
  } catch (err) {
    logger.error({ err, userId: id }, "[admin/users/suspend] suspendare eșuată — tranzacție anulată");
    return NextResponse.json({ error: "suspend_failed" }, { status: 500 });
  }

  if (outcome === "user_not_found") return NextResponse.json({ error: outcome }, { status: 404 });
  if (outcome === "cannot_suspend_admin") return NextResponse.json({ error: outcome }, { status: 400 });

  await logAdminAction({ action: "user.suspend", targetType: "user", targetId: id, details: { days, reason }, actor, req });
  await notifyLocalized(id, "accountSuspended", { url: "/account", values: { days } });
  return NextResponse.json({ ok: true, days, reason });
}
