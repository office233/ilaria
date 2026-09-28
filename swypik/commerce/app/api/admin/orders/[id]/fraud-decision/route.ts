/**
 * Admin: manual decision on a flagged order's fraud status.
 *
 *   POST /api/admin/orders/<id>/fraud-decision
 *   body: { action: "approve" | "block", reason?: string }
 *
 *   approve: clears fraud_block (cron can process), keeps audit trail.
 *   block:   force fraud_block=true (e.g. admin spots issue manually).
 *
 * Both actions are persisted in metadata.fraud_decisions[] for audit
 * and notified to ops (cooldown 1 min — admin actions are intentional, low volume).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { isUuidParam } from "@/lib/validation/params";
import { notifyOps } from "@/lib/ops/alerts";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  const { id: orderId } = await params;
  if (!isUuidParam(orderId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: { action?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body?.action || "").toLowerCase();
  const reason = String(body?.reason || "").slice(0, 500).trim();
  if (action !== "approve" && action !== "block") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const { rows } = await dbQuery<{ id: string; status: string; metadata: Record<string, unknown> | null; total_cents: number; currency: string }>(
    `SELECT id::text, status, metadata, total_cents, currency
       FROM commerce_orders WHERE id = $1 LIMIT 1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) return NextResponse.json({ error: "order_not_found" }, { status: 404 });

  const md = o.metadata || {};
  const prevBlock = md.fraud_block === true;
  const prevReview = md.fraud_review === true;

  const decision = {
    action,
    reason: reason || null,
    by: actor.userId ?? actor.kind,
    at: new Date().toISOString(),
    prev_block: prevBlock,
    prev_review: prevReview,
    score: typeof md.fraud_score === "number" ? md.fraud_score : null,
  };

  const patch: Record<string, unknown> = {
    fraud_last_decision: decision,
  };
  if (action === "approve") {
    patch.fraud_block = false;
    patch.fraud_review = false;
    patch.fraud_approved_at = decision.at;
  } else {
    patch.fraud_block = true;
    patch.fraud_review = true;
    patch.fraud_blocked_manually_at = decision.at;
  }

  // metadata poate fi NULL (NULL || x = NULL — decizia se pierdea); istoricul
  // se adaugă în SQL ca două decizii concurente să nu se suprascrie.
  await dbQuery(
    `UPDATE commerce_orders
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
            || jsonb_build_object(
                 'fraud_decisions',
                 CASE WHEN jsonb_typeof(metadata->'fraud_decisions') = 'array'
                      THEN metadata->'fraud_decisions' ELSE '[]'::jsonb END
                 || jsonb_build_array($3::jsonb))
      WHERE id = $2`,
    [JSON.stringify(patch), orderId, JSON.stringify(decision)],
  );

  logger.info({ orderId, action, reason }, `[fraud-decision] admin ${action} order ${orderId}`);

  await logAdminAction({
    action: `order.fraud_${action}`,
    targetType: "commerce_order",
    targetId: orderId,
    details: { reason: reason || null, score: decision.score },
    req,
    actor,
  });

  await notifyOps({
    key: `fraud_decision:${orderId}:${action}`,
    severity: action === "block" ? "warning" : "info",
    title: `Admin ${action.toUpperCase()} order ${orderId.slice(0, 8)} — ${(o.total_cents / 100).toFixed(2)} ${o.currency.toUpperCase()}`,
    // Alertă internă (ops), nu text de UI: format neutru, fără limbă.
    detail: `reason=${reason || "none"}`,
    link: `${APP_URL}/admin/risk?status=${o.status}`,
    payload: { orderId, action, score: decision.score },
    cooldownMin: 1,
  }).catch((e) => logger.warn({ err: e }, "[fraud-decision] notify failed"));

  return NextResponse.json({ success: true, action, orderId });
}
