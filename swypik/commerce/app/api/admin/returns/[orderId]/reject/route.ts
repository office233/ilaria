/**
 * Admin Returns — Reject
 * POST /api/admin/returns/[orderId]/reject
 * Body JSON: { reason: string } sau form-data
 *
 * Tranziția e condiționată de starea „requested” (UPDATE … WHERE): o cerere
 * deja aprobată/respinsă → 409, fără eveniment / acțiune de moderare dublă.
 */
import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam } from "@/lib/validation/params";
import { RETURN_PENDING_SQL } from "@/lib/admin/returns";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const DEFAULT_REASON_CODE = "rejected_by_admin";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  const { orderId } = await params;
  const ct = req.headers.get("content-type") || "";
  const isFormRequest = ct.includes("form") || (req.headers.get("accept")?.includes("text/html") ?? false);

  if (!isUuidParam(orderId)) {
    return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });
  }

  try {
    let reason = "";
    try {
      if (ct.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        const v = fd.get("reason");
        reason = typeof v === "string" ? v.trim() : "";
      }
    } catch {
      /* ignore malformed body, fall back to the default reason code below */
    }

    if (reason.length < 3) {
      reason = DEFAULT_REASON_CODE;
    }
    reason = reason.slice(0, 500);

    const actorRef = actor.userId ?? actor.kind;
    const outcome = await withTransaction<"not_found" | "conflict" | "ok">(async (q) => {
      const { rows } = await q<{ id: string }>(
        `SELECT id FROM commerce_orders WHERE id = $1::uuid LIMIT 1 FOR UPDATE`,
        [orderId]
      );
      if (rows.length === 0) return "not_found";

      const event = {
        type: "rejected",
        at: new Date().toISOString(),
        actor: actorRef,
        reason,
      };

      const upd = await q<{ buyer_user_id: string | null }>(
        `UPDATE commerce_orders
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'return_status', 'rejected',
                  'return_rejected_at', NOW()::text,
                  'return_rejection_reason', $2::text,
                  'return_history', COALESCE(metadata->'return_history', '[]'::jsonb) || $3::jsonb
                )
          WHERE id = $1::uuid
            AND ${RETURN_PENDING_SQL}
        RETURNING buyer_user_id`,
        [orderId, reason, JSON.stringify([event])]
      );
      if (upd.rowCount === 0) return "conflict";

      const buyer = upd.rows[0]?.buyer_user_id ?? null;
      if (buyer) {
        await q(
          `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
           VALUES ($3, $4, 'warn', 'return_rejected', jsonb_build_object('order_id', $1::text, 'rejection_reason', $2::text))`,
          [orderId, reason, actor.userId, buyer]
        );
      }
      return "ok";
    });

    if (outcome === "not_found") {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }
    if (outcome === "conflict") {
      return NextResponse.json({ error: "return_not_pending" }, { status: 409 });
    }

    await logAdminAction({
      action: "return.reject",
      targetType: "commerce_order",
      targetId: orderId,
      details: { reason },
      req,
      actor,
    });

    if (isFormRequest) {
      return NextResponse.redirect(new URL("/admin/returns", req.url), 303);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err, orderId }, "[admin/returns/reject] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
