import { withErrorHandling } from "@/lib/api-handler";
/**
 * Customer Orders API — backed by `users` + `user_sessions` tables
 * GET /api/auth/orders — list orders for authenticated customer
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { dbQuery } from "@/lib/db";
import crypto from "crypto";

const COOKIE_NAME = "swypik_session";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function GET_impl() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ success: false, error: "Not logged in" }, { status: 401 });
  }

  const sessionHash = hashToken(sessionToken);

  const { rows: sessionRows } = await dbQuery<{ user_id: string; email: string }>(
    `SELECT us.user_id, u.email
     FROM user_sessions us
     JOIN users u ON u.id = us.user_id
     WHERE us.session_token_hash = $1
       AND us.expires_at > now()
       AND us.revoked_at IS NULL
     LIMIT 1`,
    [sessionHash],
  );

  if (sessionRows.length === 0) {
    return NextResponse.json({ success: false, error: "Session expired" }, { status: 401 });
  }

  const userId = sessionRows[0].user_id;
  const email = sessionRows[0].email;

  // Get orders — try buyer_user_id first, fall back to email match
  const { rows: orders } = await dbQuery(
    `SELECT
       id, status,
       (total_cents::numeric / 100) AS total_ron,
       metadata,
       created_at,
       fulfilled_at
     FROM commerce_orders
     WHERE (buyer_user_id = $1 OR metadata->>'customer_email' = $2)
       AND status != 'cancelled'
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId, email],
  );

  // Get items for each order
  const enrichedOrders = [];
  for (const order of orders) {
    const { rows: items } = await dbQuery(
      `SELECT title, quantity, (unit_amount_cents::numeric / 100) AS unit_price
       FROM commerce_order_items WHERE order_id = $1`,
      [order.id],
    );

    const meta = order.metadata || {};
    enrichedOrders.push({
      id: order.id,
      orderLookupToken: meta.order_lookup_token || null,
      status: order.status,
      totalRon: Number(order.total_ron),
      fulfillmentStatus: meta.fulfillment_status || "pending",
      trackingNumber: meta.tracking_number || null,
      trackingUrl: meta.tracking_url || null,
      items,
      createdAt: order.created_at,
    });
  }

  return NextResponse.json({ success: true, orders: enrichedOrders });
}

export const GET = withErrorHandling(GET_impl);
