/**
 * GET  /api/seller/orders?tab=all|todo|shipped|done|issues&q=&limit=&offset=
 *      Comenzile seller-ului (doar item-urile lui), paginate, cu starea și
 *      acțiunile permise (lib/seller/orders.ts) + numărul de comenzi per tab.
 * POST /api/seller/orders { order_id, tracking_number, tracking_url? }
 *      Expediere cu tracking simplu (compatibilitate; UI-ul folosește /awb).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { rateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { SellerOrderTrackingSchema, parseBody } from "@/lib/validation/schemas";
import { paginationSchema, queryObject } from "@/lib/validation/params";
import { countSellerOrdersByTab, listSellerOrders } from "@/lib/seller/orders";
import { recordSellerShipment } from "@/lib/seller/shipping";
import { SELLER_ORDERS_PAGE_SIZE } from "@/lib/seller/config";

export const dynamic = "force-dynamic";

const QuerySchema = paginationSchema(SELLER_ORDERS_PAGE_SIZE, 50).extend({
  tab: z.enum(["all", "todo", "shipped", "done", "issues"]).default("all"),
  q: z.string().trim().max(80).optional(),
});

export async function GET(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

  const parsed = QuerySchema.safeParse(queryObject(new URL(req.url), ["tab", "q", "limit", "offset"]));
  if (!parsed.success) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
  const { tab, q, limit, offset } = parsed.data;

  try {
    const [page, counts] = await Promise.all([
      listSellerOrders(sellerId, { tab, q: q ?? null, limit, offset }),
      countSellerOrdersByTab(sellerId),
    ]);
    return NextResponse.json({ success: true, orders: page.orders, hasMore: page.hasMore, counts, limit, offset });
  } catch (error) {
    logger.error({ err: error }, "[Seller Orders API] GET Error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}

const SHIP_BLOCKED = new Set(["pending", "authorized", "cancelled", "refunded", "return_requested", "failed"]);

export async function POST(req: Request) {
  try {
    const sellerId = await getSellerSessionId();
    if (!sellerId) return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("sellerOrders", sellerId);
    if (!rl.success) return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });

    const parsed = parseBody(SellerOrderTrackingSchema, await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ success: false, error: "validation_error" }, { status: 400 });
    const { order_id, tracking_number, tracking_url } = parsed.data;

    // Fără fallback extern hardcodat: fără template configurat și fără URL explicit → fără link.
    const template = process.env.TRACKING_URL_TEMPLATE || "";
    const trackingUrl =
      tracking_url ?? (template ? template.replace("{code}", encodeURIComponent(tracking_number)) : null);

    const check = await dbQuery<{ status: string; customer_email: string | null }>(
      `SELECT co.status, co.metadata->>'customer_email' AS customer_email
         FROM commerce_orders co
         JOIN commerce_order_items coi ON co.id = coi.order_id
        WHERE co.id = $1 AND coi.metadata->>'seller_id' = $2
        LIMIT 1`,
      [order_id, sellerId],
    );
    const order = check.rows[0];
    if (!order) return NextResponse.json({ success: false, error: "not_found" }, { status: 403 });
    if (SHIP_BLOCKED.has(order.status)) {
      return NextResponse.json({ success: false, error: "invalid_status" }, { status: 409 });
    }

    await recordSellerShipment({
      orderId: order_id,
      sellerId,
      trackingNumber: tracking_number,
      trackingUrl,
      carrier: null,
      customerEmail: order.customer_email,
    });
    return NextResponse.json({ success: true, order: { order_id }, trackingNumber: tracking_number, trackingUrl });
  } catch (error) {
    logger.error({ err: error }, "[Seller Orders API] POST Error");
    return NextResponse.json({ success: false, error: "server_error" }, { status: 500 });
  }
}
