/**
 * Status comandă locală — actualizat de restaurant (seller) sau de curierul atribuit.
 * PATCH /api/local-orders/[id]/status  { status, reason? }
 *
 * Tranzițiile: lib/food/order-status.ts (pur, testat). Aplicarea atomică:
 * lib/food/transition.ts. Efectele (refund la anulare/refuz, auto-dispatch,
 * decontare, push în limba clientului): lib/food/transition-effects.ts.
 * Clientul anulează prin POST /api/local-orders/[id]/cancel.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { LocalOrderStatusSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { primaryActorFor } from "@/lib/food/order-status";
import { transitionOrder } from "@/lib/food/transition";
import { runTransitionEffects } from "@/lib/food/transition-effects";
import { captureLocalOrderPayment } from "@/lib/food/card-payment";

/** Comanda aparține restaurantului sellerului și încă așteaptă acceptarea? */
async function placedCardOrderOf(orderId: string, sellerId: string): Promise<boolean> {
    const { rows } = await dbQuery<{ id: string }>(
        `SELECT lo.id FROM local_orders lo JOIN local_merchants m ON m.id = lo.merchant_id
          WHERE lo.id = $1 AND m.seller_id = $2 AND lo.status = 'placed' AND lo.payment_method = 'card_online'`,
        [orderId, sellerId],
    );
    return rows.length > 0;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function approvedCourierId(): Promise<string | null> {
    const session = await getAuthSession();
    if (!session?.userId) return null;
    const { rows } = await dbQuery<{ id: string }>(
        `SELECT id FROM couriers WHERE user_id = $1 AND verification_status = 'approved' AND deleted_at IS NULL`,
        [session.userId],
    );
    return rows[0]?.id ?? null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        if (!isUuidParam(id)) return invalidIdResponse();
        const raw = await req.json().catch(() => null);
        const parsed = parseBody(LocalOrderStatusSchema, raw);
        if (!parsed.ok) {
            return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
        }
        const { status, reason } = parsed.data;

        const actor = primaryActorFor(status);
        if (actor !== "merchant" && actor !== "courier") {
            return NextResponse.json({ success: false, error: "invalid_status", code: "invalid_status" }, { status: 400 });
        }

        const sellerId = actor === "merchant" ? await getSellerSessionId() : null;
        const courierId = actor === "courier" ? await approvedCourierId() : null;
        if ((actor === "merchant" && !sellerId) || (actor === "courier" && !courierId)) {
            return NextResponse.json({ success: false, error: "forbidden", code: "forbidden" }, { status: 403 });
        }

        // Card: hold-ul se încasează abia la acceptarea restaurantului (audit #7).
        if (status === "accepted" && sellerId && (await placedCardOrderOf(id, sellerId))) {
            const cap = await captureLocalOrderPayment(id);
            if (!cap.ok) {
                return NextResponse.json({ success: false, error: cap.code, code: cap.code }, { status: 409 });
            }
        }

        const result = await transitionOrder({
            orderId: id,
            to: status,
            actor,
            reason: reason ?? null,
            authorize: (o) => (actor === "merchant" ? o.seller_id === sellerId : o.courier_id === courierId),
        });
        if (!result.ok) {
            return NextResponse.json(
                { success: false, error: result.code, code: result.code, from: result.from },
                { status: result.http },
            );
        }

        const { refund } = await runTransitionEffects({
            orderId: id,
            status,
            customerUserId: result.customerUserId,
            merchantName: result.merchantName,
            reason: reason ?? null,
        });

        return NextResponse.json({ success: true, order: result.order, refund_status: refund?.status ?? null });
    } catch (error: unknown) {
        logger.error({ err: error }, "[local-orders/status] error");
        return NextResponse.json({ success: false, error: "server_error", code: "server_error" }, { status: 500 });
    }
}
