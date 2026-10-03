/**
 * POST /api/admin/users/[id]/admin-role — body { adminRole: owner|ops|finance|moderator|support }
 * Schimbă rolul de admin (RBAC) al unui cont care e deja admin. Doar owner
 * (admins.manage). Protecții: nu-ți schimbi propriul rol; nu rămâne sistemul fără owner.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/admin/guard";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { logAdminAction } from "@/lib/security/admin-audit";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ adminRole: z.enum(ADMIN_ROLES) });

type Outcome = { ok: true; oldAdminRole: string | null } | { ok: false; status: number; error: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "admins.manage");
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  if (actor.userId === id) return NextResponse.json({ error: "cannot_change_own_role" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_admin_role" }, { status: 400 });
  const { adminRole } = parsed.data;

  let outcome: Outcome;
  try {
    outcome = await withTransaction<Outcome>(async (q) => {
      const { rows } = await q<{ role: string; admin_role: string | null }>(
        `SELECT role, admin_role FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const u = rows[0];
      if (!u) return { ok: false, status: 404, error: "user_not_found" };
      if (u.role !== "admin") return { ok: false, status: 400, error: "not_an_admin" };
      if (u.admin_role === "owner" && adminRole !== "owner") {
        const { rows: owners } = await q<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND admin_role = 'owner' AND id <> $1`,
          [id],
        );
        if ((owners[0]?.c ?? 0) === 0) return { ok: false, status: 400, error: "last_owner_lockout" };
      }
      await q(`UPDATE users SET admin_role = $2, updated_at = now() WHERE id = $1`, [id, adminRole]);
      return { ok: true, oldAdminRole: u.admin_role };
    });
  } catch (err) {
    logger.error({ err, userId: id }, "[admin/users/admin-role] failed");
    return NextResponse.json({ error: "role_change_failed" }, { status: 500 });
  }

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  await logAdminAction({
    action: "user.admin_role_change",
    targetType: "user",
    targetId: id,
    details: { oldAdminRole: outcome.oldAdminRole, newAdminRole: adminRole },
    actor,
    req,
  });
  return NextResponse.json({ ok: true, adminRole });
}
