/**
 * Comenzile unui comerciant local — pentru panoul merchant (polling).
 *
 * GET /api/merchants/[id]/orders?status=&since=&limit=
 *   Auth: sellerul proprietar (seller session).
 *   `since` (ISO) — doar comenzile plasate/actualizate după acel moment.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { withErrorHandling } from "@/lib/api-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_STATUSES: readonly string[] = ["placed", "accepted", "preparing", "ready", "picked_up", "delivering"];

async function GET_impl(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ success: false, error: "ID invalid" }, { status: 400 });
  }

  // Ownership: merchantul trebuie să aparțină sellerului logat.
  const { rows: mRows } = await dbQuery<{ id: string }>(
    `SELECT id FROM local_merchants WHERE id = $1 AND seller_id = $2`,
    [id, sellerId],
  );
  if (mRows.length === 0) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status")?.trim() || null;
  const sinceRaw = url.searchParams.get("since")?.trim() || null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  const where: string[] = ["merchant_id = $1"];
  const params: unknown[] = [id];

  if (status === "active") {
    where.push(`status = ANY(${params.length + 1})`);
    params.push(ACTIVE_STATUSES);
    // Comenzile cu cardul apar la restaurant abia după autorizarea hold-ului
    // (audit food-go #16: altfel „comenzi fantomă" neplătite, cu sunet).
    where.push(`NOT (payment_method = 'card_online' AND payment_status <> 'paid' AND payment_authorized_at IS NULL)`);
  } else if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (!Number.isNaN(since.getTime())) {
      params.push(since.toISOString());
      where.push(`GREATEST(placed_at, updated_at) > $${params.length}`);
    }
  }

  params.push(limit);
  const { rows } = await dbQuery(
    `SELECT id, order_number, status, customer_name, customer_phone,
            delivery_address, delivery_notes, items,
            subtotal_cents, delivery_fee_cents, tip_cents, total_cents, currency,
            payment_method, payment_status, payment_authorized_at, refund_status, dispatch_status, cancel_reason,
            courier_id, placed_at, accepted_at, ready_at,
            picked_up_at, delivered_at, updated_at
       FROM local_orders
      WHERE ${where.join(" AND ")}
      ORDER BY placed_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return NextResponse.json({ success: true, orders: rows, server_time: new Date().toISOString() });
}

export const GET = withErrorHandling(GET_impl);
