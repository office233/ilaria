import { withErrorHandling } from "@/lib/api-handler";
/**
 * GET  /api/admin/strikes        — list highest-risk users
 * GET  /api/admin/strikes?userId=<uuid> — strike history for one user
 * POST /api/admin/strikes/revoke — revoke a strike { strikeId, notes? }
 *
 * Auth: requireAdmin("moderation").
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam } from "@/lib/validation/params";
import { logAdminAction } from "@/lib/security/admin-audit";

export const dynamic = "force-dynamic";

async function GET_impl(req: Request) {
  const actor = await requireAdmin(req, "moderation");
  if (actor instanceof NextResponse) return actor;

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");

  if (userId) {
    if (!isUuidParam(userId)) {
      return NextResponse.json({ error: "invalid_id" }, { status: 400 });
    }
    const { rows: strikes } = await dbQuery(
      `SELECT s.id, s.severity, s.label, s.context, s.reason,
              s.ref_type, s.ref_id, s.reasons, s.created_at,
              s.expires_at, s.status, s.revoked_at, s.notes
         FROM user_strikes s
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT 100`,
      [userId],
    );
    const { rows: scoreRow } = await dbQuery(
      `SELECT r.score, r.strike_count, r.blocked_count, r.adult_count,
              r.sensitive_count, r.last_strike_at,
              u.status, u.suspended_until, u.suspension_reason
         FROM users u
         LEFT JOIN user_risk_scores r ON r.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );
    return NextResponse.json({ userId, summary: scoreRow[0] ?? null, strikes });
  }

  const { rows } = await dbQuery(
    `SELECT r.user_id,
            u.username, u.display_name, u.status, u.suspended_until,
            r.score, r.strike_count, r.blocked_count, r.adult_count,
            r.sensitive_count, r.last_strike_at
       FROM user_risk_scores r
       JOIN users u ON u.id = r.user_id
      WHERE r.score > 0
      ORDER BY r.score DESC, r.last_strike_at DESC NULLS LAST
      LIMIT 100`,
  );
  return NextResponse.json({ users: rows });
}

async function POST_impl(req: Request) {
  const actor = await requireAdmin(req, "moderation");
  if (actor instanceof NextResponse) return actor;

  const body = (await req.json().catch(() => null)) as {
    strikeId?: string;
    notes?: string;
  } | null;
  if (!body?.strikeId) {
    return NextResponse.json({ error: "strike_id_required" }, { status: 400 });
  }
  if (!isUuidParam(body.strikeId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 1000) : null;

  const { rows } = await dbQuery<{ user_id: string }>(
    `UPDATE user_strikes
        SET status = 'revoked',
            revoked_at = now(),
            revoked_by = $2,
            notes = COALESCE($3, notes)
      WHERE id = $1
        AND status = 'active'
      RETURNING user_id`,
    [body.strikeId, actor.userId, notes],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "strike_not_found_or_revoked" }, { status: 404 });
  }

  // Trigger a recompute via the SQL helper.
  await dbQuery(`SELECT * FROM decay_user_strikes()`);

  await logAdminAction({
    action: "strike.revoke",
    targetType: "user_strike",
    targetId: body.strikeId,
    details: { userId: rows[0].user_id },
    req,
    actor,
  });

  return NextResponse.json({ ok: true, userId: rows[0].user_id });
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
