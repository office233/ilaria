/**
 * Admin Returns — Approve
 * POST /api/admin/returns/[orderId]/approve
 * Body JSON: { refundAmountCents?: number } sau form-data (HTML form fallback)
 * Marchează cererea de retur ca aprobată. NU lansează Stripe refund automat —
 * seller / webhook se ocupă; admin doar deblochează workflow-ul.
 *
 * Idempotent: tranziția e condiționată de starea „requested” (UPDATE … WHERE),
 * într-o tranzacție; al doilea apel (dublu-click, două tab-uri) → 409, fără
 * a mai adăuga încă un eveniment / încă o acțiune de moderare.
 */
import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam } from "@/lib/validation/params";
import { RETURN_PENDING_SQL } from "@/lib/admin/returns";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

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
    let requestedRefundCents: number | null = null;
    try {
      if (ct.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        if (typeof body?.refundAmountCents === "number") {
          requestedRefundCents = body.refundAmountCents;
        }
      } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        const v = fd.get("refundAmountCents");
        if (typeof v === "string" && v.trim()) {
          const n = Number(v);
          if (Number.isFinite(n)) requestedRefundCents = n;
        }
      }
    } catch {
      /* ignore malformed body, fall back to full-amount refund below */
    }

    type Outcome =
      | { kind: "not_found" }
      | { kind: "conflict"; returnStatus: string | null }
      | { kind: "invalid"; error: string }
      | { kind: "ok"; refundAmountCents: number };

    const actorRef = actor.userId ?? actor.kind;
    const outcome = await withTransaction<Outcome>(async (q) => {
      const { rows } = await q<{ id: string; status: string; total_cents: number; return_status: string | null }>(
        `SELECT id, status, total_cents, metadata->>'return_status' AS return_status
           FROM commerce_orders WHERE id = $1::uuid LIMIT 1 FOR UPDATE`,
        [orderId]
      );
      if (rows.length === 0) return { kind: "not_found" };
      const order = rows[0];

      // Validate the requested refund amount server-side: never allow refunding
      // more than the order actually cost, and never a negative amount.
      let refundAmountCents: number;
      if (requestedRefundCents == null) {
        refundAmountCents = order.total_cents;
      } else if (!Number.isFinite(requestedRefundCents) || requestedRefundCents < 0) {
        return { kind: "invalid", error: "invalid_refund_amount" };
      } else if (requestedRefundCents > order.total_cents) {
        return { kind: "invalid", error: "refund_exceeds_order_total" };
      } else {
        refundAmountCents = Math.round(requestedRefundCents);
      }

      const event = {
        type: "approved",
        at: new Date().toISOString(),
        actor: actorRef,
        refundAmountCents,
      };

      const upd = await q<{ buyer_user_id: string | null }>(
        `UPDATE commerce_orders
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'return_status', 'approved',
                  'return_approved_at', NOW()::text,
                  'return_approved_by', $4::text,
                  'return_refund_amount_cents', $2::int,
                  'return_history', COALESCE(metadata->'return_history', '[]'::jsonb) || $3::jsonb
                )
          WHERE id = $1::uuid
            AND ${RETURN_PENDING_SQL}
        RETURNING buyer_user_id`,
        [orderId, refundAmountCents, JSON.stringify([event]), actorRef]
      );
      if (upd.rowCount === 0) return { kind: "conflict", returnStatus: order.return_status };

      const buyer = upd.rows[0]?.buyer_user_id ?? null;
      if (buyer) {
        await q(
          `INSERT INTO moderation_actions (actor_user_id, target_user_id, action_type, reason, metadata)
           VALUES ($3, $4, 'warn', 'return_approved', jsonb_build_object('order_id', $1::text, 'refund_amount_cents', $2::int))`,
          [orderId, refundAmountCents, actor.userId, buyer]
        );
      }
      return { kind: "ok", refundAmountCents };
    });

    if (outcome.kind === "not_found") {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }
    if (outcome.kind === "invalid") {
      return NextResponse.json({ error: outcome.error }, { status: 400 });
    }
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        { error: "return_not_pending", returnStatus: outcome.returnStatus },
        { status: 409 }
      );
    }
    const { refundAmountCents } = outcome;

    await logAdminAction({
      action: "return.approve",
      targetType: "commerce_order",
      targetId: orderId,
      details: { refundAmountCents },
      req,
      actor,
    });

    if (isFormRequest) {
      return NextResponse.redirect(new URL("/admin/returns", req.url), 303);
    }
    return NextResponse.json({ success: true, refundAmountCents });
  } catch (err) {
    logger.error({ err, orderId }, "[admin/returns/approve] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
