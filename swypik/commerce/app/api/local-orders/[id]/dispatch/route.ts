/**
 * Dispatch — oferă comanda curierilor online din oraș, cel mai apropiat primul.
 *
 * POST /api/local-orders/[id]/dispatch   (merchant/admin) → creează oferte
 * PATCH /api/local-orders/[id]/dispatch  (curier) → accept/refuz ofertă
 *
 * Logica de atribuire trăiește în lib/dispatch/engine.ts (dispatch_jobs +
 * valuri cu rază crescătoare). Atribuirea folosește SELECT ... FOR UPDATE
 * într-o tranzacție, ca doi curieri să nu poată accepta simultan.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { logger } from "@/lib/logger";
import { sendMobilityPush } from "@/lib/dispatch/push-i18n";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import {
    createJob,
    acceptOffer,
    declineOffer,
    OFFER_TTL_SECONDS,
} from "@/lib/dispatch/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        if (!isUuidParam(id)) return invalidIdResponse();
        const sellerId = await getSellerSessionId();
        if (!sellerId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        // Comanda trebuie să aparțină merchantului acestui seller și să fie gata de ridicat.
        const { rows: orders } = await dbQuery(
            `SELECT lo.id, lo.status, lo.dispatch_status, lo.courier_id,
              m.location_city, m.location_lat, m.location_lng, m.seller_id
         FROM local_orders lo
         JOIN local_merchants m ON m.id = lo.merchant_id
        WHERE lo.id = $1`,
            [id],
        );
        const order = orders[0];
        if (!order || order.seller_id !== sellerId) {
            return NextResponse.json({ success: false, error: "Comanda nu există." }, { status: 404 });
        }
        if (order.courier_id) {
            return NextResponse.json({ success: false, error: "Comanda are deja curier." }, { status: 409 });
        }
        if (!["accepted", "preparing", "ready"].includes(order.status)) {
            return NextResponse.json(
                { success: false, error: "Comanda nu e în stadiul potrivit pentru dispatch." },
                { status: 409 },
            );
        }

        // Motorul creează jobul + primul val de oferte (rază 2 km).
        // Dacă nu există curieri în primul val, worker-ul avansează valurile
        // (5 km, 10 km) și abia apoi marchează no_courier.
        const { offered } = await createJob({
            kind: "delivery",
            orderId: id,
            city: order.location_city,
            pickupLat: order.location_lat,
            pickupLng: order.location_lng,
        });

        return NextResponse.json({
            success: true,
            offered,
            expires_in_seconds: OFFER_TTL_SECONDS,
        });
    } catch (error: unknown) {
        logger.error({ err: error }, "[dispatch] POST error");
        return NextResponse.json({ success: false, error: "Eroare la dispatch." }, { status: 500 });
    }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        if (!isUuidParam(id)) return invalidIdResponse();
        const session = await getAuthSession();
        if (!session?.userId) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json().catch(() => null);
        const accept = body?.accept === true;

        const { rows: cRows } = await dbQuery(
            `SELECT id FROM couriers WHERE user_id = $1 AND verification_status = 'approved' AND deleted_at IS NULL`,
            [session.userId],
        );
        const courierId = cRows[0]?.id;
        if (!courierId) {
            return NextResponse.json({ success: false, error: "Nu ești curier aprobat." }, { status: 403 });
        }

        if (!accept) {
            await declineOffer(id, courierId);
            return NextResponse.json({ success: true, accepted: false });
        }

        // Atribuire atomică prin engine (FOR UPDATE pe job + comandă).
        const result = await acceptOffer(id, courierId);

        if (!result.ok) {
            return NextResponse.json({ success: false, error: result.error }, { status: result.code });
        }

        const { rows } = await dbQuery(
            `SELECT lo.order_number, lo.delivery_address, lo.delivery_lat, lo.delivery_lng,
              lo.customer_name, lo.customer_phone, lo.customer_user_id, lo.items, lo.total_cents, lo.payment_method,
              m.name AS merchant_name, m.address AS pickup_address,
              m.location_lat AS pickup_lat, m.location_lng AS pickup_lng
         FROM local_orders lo JOIN local_merchants m ON m.id = lo.merchant_id
        WHERE lo.id = $1`,
            [id],
        );

        // Push best-effort către client: curier găsit.
        const row = rows[0];
        if (row?.customer_user_id) {
            void sendMobilityPush(row.customer_user_id, "courierFound", {
                url: `/food/orders/${id}`,
                tag: `eats-order-${id}`,
                vars: { merchant: row.merchant_name },
            });
        }

        return NextResponse.json({ success: true, accepted: true, delivery: rows[0] });
    } catch (error: unknown) {
        logger.error({ err: error }, "[dispatch] PATCH error");
        return NextResponse.json({ success: false, error: "Eroare." }, { status: 500 });
    }
}
