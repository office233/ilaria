/**
 * Admin: block or unblock a user from placing any future orders.
 *
 *   POST /api/admin/users/<uuid>/fraud-block
 *   body: { action: "block" | "unblock", reason: string }
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { setUserFraudBlock } from "@/lib/risk/user-block";
import { logAdminAction } from "@/lib/security/admin-audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  const { id: userId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { action?: string; reason?: string };
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body?.action || "").toLowerCase();
  const reason = String(body?.reason || "").slice(0, 500).trim();
  if (action !== "block" && action !== "unblock") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 400 });
  }

  const { rows } = await dbQuery<{ id: string }>(`SELECT id::text FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (!rows[0]) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  await setUserFraudBlock({
    userId,
    blocked: action === "block",
    reason,
    by: "admin",
  });

  await logAdminAction({
    action: `user.fraud_${action}`,
    targetType: "user",
    targetId: userId,
    details: { reason },
    actor,
    req,
  });

  return NextResponse.json({ success: true, action, userId });
}
