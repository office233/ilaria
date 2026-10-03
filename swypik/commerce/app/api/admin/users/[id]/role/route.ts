/**
 * POST /api/admin/users/[id]/role — body { role, adminRole? }
 *
 * Roluri de cont: shopper | creator | seller | admin (cf. users_role_check;
 * vechiul „user” încălca constrângerea). Permisiuni:
 *   - schimbări între shopper/creator/seller: users.manage;
 *   - a face pe cineva admin sau a retrage rolul de admin: admins.manage (doar owner).
 *     Un secret de mașină scurs NU poate crea admini.
 * Orice schimbare revocă sesiunile utilizatorului (inclusiv de admin).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction, type TxQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/admin/guard";
import { ADMIN_ROLES, hasPermission } from "@/lib/admin/permissions";
import { logAdminAction } from "@/lib/security/admin-audit";
import { revokeAdminSessionsForUser } from "@/lib/security/admin-auth";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT_ROLES = ["shopper", "creator", "seller", "admin"] as const;

const Body = z.object({
  role: z.enum(ACCOUNT_ROLES),
  adminRole: z.enum(ADMIN_ROLES).optional(),
});

type Outcome =
  | { ok: true; oldRole: string; newRole: string; adminRole: string | null }
  | { ok: false; status: number; error: string };

async function revokeAll(q: TxQuery, id: string, oldRole: string) {
  await q(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
  await revokeAdminSessionsForUser(id, q);
  if (oldRole === "seller") {
    await q(
      `DELETE FROM seller_sessions WHERE seller_id IN (
         SELECT s.id FROM sellers s JOIN users u ON lower(u.email) = lower(s.email) WHERE u.id = $1)`,
      [id],
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "users.manage");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  const { role } = parsed.data;

  let outcome: Outcome;
  try {
    outcome = await withTransaction<Outcome>(async (q) => {
      const { rows } = await q<{ role: string }>(`SELECT role FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return { ok: false, status: 404, error: "user_not_found" };
      const oldRole = rows[0].role;
      const touchesAdmin = role === "admin" || oldRole === "admin";
      if (touchesAdmin && !hasPermission(actor.role, "admins.manage")) {
        return { ok: false, status: 403, error: "forbidden" };
      }
      if (oldRole === "admin" && role !== "admin") {
        if (actor.userId === id) return { ok: false, status: 400, error: "cannot_demote_self" };
        const { rows: others } = await q<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND admin_role = 'owner' AND id <> $1`,
          [id],
        );
        if ((others[0]?.c ?? 0) === 0) return { ok: false, status: 400, error: "last_admin_lockout" };
      }
      if (oldRole === role) return { ok: true, oldRole, newRole: role, adminRole: null };

      const adminRole = role === "admin" ? (parsed.data.adminRole ?? "support") : null;
      await q(`UPDATE users SET role = $2, admin_role = $3, updated_at = now() WHERE id = $1`, [id, role, adminRole]);
      await revokeAll(q, id, oldRole);
      await q(
        `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
         VALUES ($1, $2, 'warn', 'role_change', $3::jsonb)`,
        [actor.userId, id, JSON.stringify({ source: "admin_users_page", kind: "role_change", old_role: oldRole, new_role: role })],
      );
      return { ok: true, oldRole, newRole: role, adminRole };
    });
  } catch (err) {
    logger.error({ err, userId: id, role }, "[admin/users/role] schimbare de rol eșuată — tranzacție anulată");
    return NextResponse.json({ error: "role_change_failed" }, { status: 500 });
  }

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  if (outcome.oldRole !== outcome.newRole) {
    await logAdminAction({
      action: "user.role_change",
      targetType: "user",
      targetId: id,
      details: { oldRole: outcome.oldRole, newRole: outcome.newRole, adminRole: outcome.adminRole },
      actor,
      req,
    });
  }
  return NextResponse.json({ ok: true, role: outcome.newRole, adminRole: outcome.adminRole });
}
