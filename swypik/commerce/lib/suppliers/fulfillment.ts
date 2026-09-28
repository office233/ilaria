/**
 * Fulfillment manual — fără furnizori externi de dropshipping.
 *
 * Comenzile fără seller (marketplace propriu / istoric) se procesează manual
 * de către admin: marcare fulfilled, tracking, anulare. Sellerii reali au
 * fluxul lor în panoul nativ /seller (Stripe Connect).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "suppliers/fulfillment" });

export type FulfillmentResult = {
    success: boolean;
    orderId: string;
    status?: string;
    note?: string;
    error?: string;
};

/** Marchează comanda ca preluată în procesare manuală. */
export async function fulfillOrder(orderId: string): Promise<FulfillmentResult> {
    const { rows } = await dbQuery<{ id: string; status: string }>(
        `UPDATE commerce_orders
        SET status = 'processing', updated_at = now()
      WHERE id = $1 AND status IN ('paid', 'pending_fulfillment')
      RETURNING id, status`,
        [orderId],
    );
    if (!rows.length) {
        return { success: false, orderId, error: "order_not_found_or_not_fulfillable" };
    }
    log.info({ orderId }, "order moved to manual processing");
    return { success: true, orderId, status: rows[0].status, note: "Procesare manuală" };
}

/** Setează tracking-ul și marchează comanda expediată. */
export async function updateOrderTracking(
    orderId: string,
    trackingNumber: string,
    trackingUrl?: string,
): Promise<boolean> {
    const { rows } = await dbQuery(
        `UPDATE commerce_orders
        SET metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('tracking_number', $2::text)
            || CASE WHEN $3::text IS NOT NULL
                THEN jsonb_build_object('tracking_url', $3::text)
                ELSE '{}'::jsonb END,
            status = 'shipped',
            updated_at = now()
      WHERE id = $1
      RETURNING id`,
        [orderId, trackingNumber, trackingUrl ?? null],
    );
    return rows.length > 0;
}

/** Anulează comanda (motivul se păstrează în metadata). */
export async function cancelOrder(orderId: string, reason?: string): Promise<boolean> {
    const { rows } = await dbQuery(
        `UPDATE commerce_orders
        SET status = 'cancelled',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancel_reason', $2::text),
            updated_at = now(),
            cancelled_at = now()
      WHERE id = $1 AND status NOT IN ('delivered', 'cancelled')
      RETURNING id`,
        [orderId, reason ?? null],
    );
    return rows.length > 0;
}
