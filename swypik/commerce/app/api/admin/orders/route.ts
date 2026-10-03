/**
 * Admin Orders API
 * GET  /api/admin/orders        — list all orders with filters
 * PATCH /api/admin/orders       — update order status/tracking
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";

import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { paginationSchema, queryObject } from "@/lib/validation/params";

import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { AdminOrderPatchSchema, parseBody } from "@/lib/validation/schemas";
export const dynamic = "force-dynamic";

/** limit ∈ [1,100], offset ≥ 0 — `?limit=-5` era interpolat direct în SQL (500). */
const ListQuerySchema = paginationSchema(50, 100).extend({
  status: z.string().max(40).optional(),
});

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  const url = new URL(req.url);
  const q = ListQuerySchema.safeParse(queryObject(url, ["limit", "offset", "status"]));
  if (!q.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const { limit, offset } = q.data;
  const status = q.data.status ?? "";

  let whereClause = "";
  const params: string[] = [];

  if (status) {
    params.push(status);
    whereClause = `WHERE o.status = $${params.length}`;
  }

  const { rows: orders } = await dbQuery(
    `SELECT
       o.id,
       o.status,
       (o.total_cents::numeric / 100) AS total_ron,
       o.metadata,
       o.created_at,
       o.fulfilled_at,
       (SELECT count(*) FROM commerce_order_items WHERE order_id = o.id) AS item_count
     FROM commerce_orders o
     ${whereClause}
     ORDER BY o.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await dbQuery(
    `SELECT count(*) FROM commerce_orders o ${whereClause}`,
    params
  );

  interface AdminOrderRow {
    id: string;
    status: string;
    total_ron: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    fulfilled_at: string | null;
    item_count: string;
  }
  const formattedOrders = (orders as AdminOrderRow[]).map((o) => {
    const meta = o.metadata || {};
    return {
      id: o.id,
      status: o.status,
      fulfillmentStatus: meta.fulfillment_status || "pending",
      totalRon: Number(o.total_ron),
      itemCount: Number(o.item_count),
      customerEmail: meta.customer_email || meta.email || null,
      trackingNumber: meta.tracking_number || null,
      source: meta.source || "unknown",
      createdAt: o.created_at,
      fulfilledAt: o.fulfilled_at,
    };
  });

  return NextResponse.json({
    orders: formattedOrders,
    total: Number(countRows[0]?.count || 0),
    limit,
    offset,
  });
}

export async function PATCH(req: Request) {
  const actor = await requireAdmin(req, "commerce");
  if (actor instanceof NextResponse) return actor;

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = parseBody(AdminOrderPatchSchema, rawBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { orderId, status, trackingNumber, trackingUrl, fulfillmentStatus, notes } = parsed.data;

    const updates: string[] = [];
    const params: string[] = [orderId];
    const metaUpdates: Record<string, unknown> = {};

    if (status) {
      params.push(status);
      updates.push(`status = $${params.length}`);
    }

    if (fulfillmentStatus) {
      metaUpdates.fulfillment_status = fulfillmentStatus;
      if (fulfillmentStatus === "fulfilled" || fulfillmentStatus === "shipped") {
        updates.push(`fulfilled_at = NOW()`);
      }
    }

    if (trackingNumber) {
      metaUpdates.tracking_number = trackingNumber;
      metaUpdates.latest_tracking_number = trackingNumber;
    }

    if (trackingUrl) {
      metaUpdates.tracking_url = trackingUrl;
      metaUpdates.latest_tracking_url = trackingUrl;
    }

    if (notes) {
      metaUpdates.admin_notes = notes;
    }

    metaUpdates.updated_at = new Date().toISOString();
    metaUpdates.updated_by = actor.userId ?? actor.kind;

    params.push(JSON.stringify(metaUpdates));
    updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${params.length}::jsonb`);

    const sql = `UPDATE commerce_orders SET ${updates.join(", ")} WHERE id = $1 RETURNING id, status, metadata`;
    const { rows } = await dbQuery(sql, params);

    if (rows.length === 0) {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }

    await logAdminAction({
      action: "order.update",
      targetType: "commerce_order",
      targetId: orderId,
      details: { status, fulfillmentStatus, trackingNumber: trackingNumber ? "[set]" : undefined },
      req,
      actor,
    });

    return NextResponse.json({ success: true, order: rows[0] });
  } catch (error: unknown) {
    logger.error({ err: error }, "[Admin Orders PATCH]");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
