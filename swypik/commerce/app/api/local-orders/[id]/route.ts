/**
 * GET /api/local-orders/[id] — detaliile unei comenzi, pentru tracking live.
 *
 * Autorizare: clientul comenzii, curierul asignat, merchantul (seller) sau admin.
 * Include: statusuri + timestamps, merchant, curier (nume/vehicul/poziție live),
 * job-ul de dispatch activ (pentru abonarea la SSE /api/dispatch/[jobId]/stream).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { logger } from "@/lib/logger";
import { guestTokenFromRequest, guestTokenMatches } from "@/lib/food/guest-token";
import { CUSTOMER_CANCELLABLE, type OrderStatus } from "@/lib/food/order-status";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_POSITION_STATUSES = new Set(["picked_up", "delivering"]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        if (!UUID_RE.test(id)) {
            return NextResponse.json({ success: false, error: "invalid_id", code: "invalid_id" }, { status: 400 });
        }

        const { rows } = await dbQuery(
            `SELECT lo.id, lo.order_number, lo.status, lo.dispatch_status, lo.items,
              lo.subtotal_cents, lo.delivery_fee_cents, lo.tip_cents, lo.total_cents,
              lo.currency, lo.payment_method, lo.payment_status,
              lo.delivery_address, lo.delivery_lat, lo.delivery_lng, lo.delivery_notes,
              lo.customer_user_id, lo.customer_name, lo.customer_phone,
              lo.placed_at, lo.accepted_at, lo.ready_at, lo.picked_up_at,
              lo.delivered_at, lo.estimated_delivery_at, lo.cancel_reason,
              lo.refund_status, lo.refunded_at, lo.cancelled_by, lo.guest_token_hash,
              m.id AS merchant_id, m.name AS merchant_name, m.slug AS merchant_slug,
              m.image_url AS merchant_image, m.phone AS merchant_phone,
              m.location_lat AS merchant_lat, m.location_lng AS merchant_lng,
              m.seller_id AS merchant_seller_id, m.avg_prep_minutes,
              c.id AS courier_id, c.user_id AS courier_user_id, c.full_name AS courier_name,
              c.phone AS courier_phone,
              c.vehicle_type AS courier_vehicle, c.current_lat AS courier_lat,
              c.current_lng AS courier_lng, c.location_updated_at AS courier_location_at,
              j.id AS dispatch_job_id, j.status AS dispatch_job_status
         FROM local_orders lo
         JOIN local_merchants m ON m.id = lo.merchant_id
         LEFT JOIN couriers c ON c.id = lo.courier_id
         LEFT JOIN LATERAL (
              SELECT id, status FROM dispatch_jobs
               WHERE order_id = lo.id
               ORDER BY created_at DESC LIMIT 1
         ) j ON true
        WHERE lo.id = $1`,
            [id],
        );
        const o = rows[0];
        if (!o) {
            return NextResponse.json({ success: false, error: "not_found", code: "not_found" }, { status: 404 });
        }

        // ── autorizare ──
        const authUser = await getAuthUser().catch(() => null);
        let allowed = authUser?.isAdmin === true;
        let isCustomer = false;
        if (!allowed) {
            const session = await getAuthSession();
            if (session?.userId) {
                isCustomer = o.customer_user_id === session.userId;
                allowed = isCustomer || o.courier_user_id === session.userId;
            }
        }
        // Comandă guest: token-ul primit la plasare (?t= sau x-order-token).
        if (!allowed && guestTokenMatches(guestTokenFromRequest(req), o.guest_token_hash)) {
            allowed = true;
            isCustomer = true;
        }
        if (!allowed) {
            const sellerId = await getSellerSessionId().catch(() => null);
            allowed = !!sellerId && o.merchant_seller_id === sellerId;
        }
        if (!allowed) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        // Poziția curierului doar cât livrarea e în curs (audit food-go #9);
        // adminul o vede mereu (dispecerat).
        const showCourierPosition = authUser?.isAdmin === true || LIVE_POSITION_STATUSES.has(o.status);

        return NextResponse.json({
            success: true,
            order: {
                id: o.id,
                order_number: o.order_number,
                status: o.status,
                dispatch_status: o.dispatch_status,
                items: o.items,
                subtotal_cents: o.subtotal_cents,
                delivery_fee_cents: o.delivery_fee_cents,
                tip_cents: o.tip_cents,
                total_cents: o.total_cents,
                currency: o.currency,
                payment_method: o.payment_method,
                payment_status: o.payment_status,
                delivery_address: o.delivery_address,
                delivery_lat: o.delivery_lat,
                delivery_lng: o.delivery_lng,
                delivery_notes: o.delivery_notes,
                placed_at: o.placed_at,
                accepted_at: o.accepted_at,
                ready_at: o.ready_at,
                picked_up_at: o.picked_up_at,
                delivered_at: o.delivered_at,
                estimated_delivery_at: o.estimated_delivery_at,
                cancel_reason: o.cancel_reason,
                cancelled_by: o.cancelled_by,
                refund_status: o.refund_status,
                refunded_at: o.refunded_at,
                can_cancel: isCustomer && CUSTOMER_CANCELLABLE.includes(o.status as OrderStatus),
                merchant: {
                    id: o.merchant_id,
                    name: o.merchant_name,
                    slug: o.merchant_slug,
                    image_url: o.merchant_image,
                    phone: o.merchant_phone,
                    lat: o.merchant_lat,
                    lng: o.merchant_lng,
                    avg_prep_minutes: o.avg_prep_minutes,
                },
                courier: o.courier_id
                    ? {
                          id: o.courier_id,
                          name: o.courier_name,
                          // Telefonul se dezvăluie doar cât timp livrarea e în curs.
                          phone: ["ready", "picked_up", "delivering"].includes(o.status)
                              ? o.courier_phone
                              : null,
                          vehicle_type: o.courier_vehicle,
                          lat: showCourierPosition ? o.courier_lat : null,
                          lng: showCourierPosition ? o.courier_lng : null,
                          location_at: showCourierPosition ? o.courier_location_at : null,
                      }
                    : null,
                dispatch_job_id: o.dispatch_job_id ?? null,
                dispatch_job_status: o.dispatch_job_status ?? null,
            },
        });
    } catch (error: unknown) {
        logger.error({ err: error }, "[local-orders/:id] GET error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}
