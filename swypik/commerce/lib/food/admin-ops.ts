/**
 * Consola de dispecerat Food din /admin/go (audit food-go #7): comenzile active,
 * cu cele blocate marcate, și acțiunile adminului:
 *   - cancel     → anulare din orice stare nefinală + refund / eliberare hold;
 *   - reassign   → scoate curierul curent (accepted|preparing|ready) și repornește
 *                  căutarea (job nou de dispatch);
 *   - delivered  → marchează livrată (curierul a uitat să confirme).
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { createJob, getJobForOrder, publishJobEvent } from "@/lib/dispatch/engine";
import { releaseJobForOrder } from "@/lib/dispatch/lifecycle";
import { transitionOrder } from "./transition";
import { runTransitionEffects } from "./transition-effects";
import { ACTIVE_STATUSES } from "./order-status";
import { staleActiveMinutes, placedTimeoutMinutes } from "./watchdog";

export type AdminFoodOrder = {
  id: string;
  order_number: string;
  status: string;
  dispatch_status: string;
  payment_method: string;
  payment_status: string;
  total_cents: number;
  currency: string;
  merchant_name: string;
  courier_id: string | null;
  courier_name: string | null;
  placed_at: string;
  updated_at: string;
  stuck: boolean;
};

export async function listActiveFoodOrders(): Promise<AdminFoodOrder[]> {
  const { rows } = await dbQuery<AdminFoodOrder>(
    `SELECT lo.id, lo.order_number, lo.status, lo.dispatch_status, lo.payment_method, lo.payment_status,
            lo.total_cents::int AS total_cents, trim(lo.currency) AS currency, m.name AS merchant_name,
            lo.courier_id, c.full_name AS courier_name, lo.placed_at::text, lo.updated_at::text,
            ((lo.status = 'placed' AND lo.placed_at < now() - make_interval(mins => $2))
              OR (lo.status <> 'placed' AND lo.updated_at < now() - make_interval(mins => $3))
              OR lo.dispatch_status = 'no_courier') AS stuck
       FROM local_orders lo
       JOIN local_merchants m ON m.id = lo.merchant_id
       LEFT JOIN couriers c ON c.id = lo.courier_id
      WHERE lo.status = ANY($1::text[])
      ORDER BY stuck DESC, lo.placed_at ASC
      LIMIT 200`,
    [ACTIVE_STATUSES, placedTimeoutMinutes(), staleActiveMinutes()],
  );
  return rows;
}

export type AdminFoodResult = { ok: true; status?: string; refund_status?: string | null } | { ok: false; error: string; code: number };

export async function adminCancelFoodOrder(orderId: string, reason: string | null): Promise<AdminFoodResult> {
  const r = await transitionOrder({ orderId, to: "cancelled", actor: "admin", reason: reason ?? "admin_cancelled", authorize: () => true });
  if (!r.ok) return { ok: false, error: r.code, code: r.http };
  const { refund } = await runTransitionEffects({
    orderId,
    status: "cancelled",
    customerUserId: r.customerUserId,
    merchantName: r.merchantName,
    reason: reason ?? "admin_cancelled",
  });
  return { ok: true, status: "cancelled", refund_status: refund?.status ?? null };
}

export async function adminMarkFoodDelivered(orderId: string): Promise<AdminFoodResult> {
  const r = await transitionOrder({ orderId, to: "delivered", actor: "admin", authorize: () => true });
  if (!r.ok) return { ok: false, error: r.code, code: r.http };
  await runTransitionEffects({ orderId, status: "delivered", customerUserId: r.customerUserId, merchantName: r.merchantName });
  return { ok: true, status: "delivered" };
}

const REASSIGNABLE = ["accepted", "preparing", "ready"];

/** Scoate curierul (dacă există) și repornește căutarea. */
export async function adminReassignFoodOrder(orderId: string): Promise<AdminFoodResult> {
  const res = await withTransaction<AdminFoodResult & { city?: string | null; lat?: number | null; lng?: number | null }>(async (q) => {
    const { rows } = await q<{ status: string; location_city: string | null; location_lat: number | null; location_lng: number | null }>(
      `SELECT lo.status, m.location_city, m.location_lat, m.location_lng
         FROM local_orders lo JOIN local_merchants m ON m.id = lo.merchant_id
        WHERE lo.id = $1 FOR UPDATE OF lo`,
      [orderId],
    );
    const o = rows[0];
    if (!o) return { ok: false, error: "not_found", code: 404 };
    if (!REASSIGNABLE.includes(o.status)) return { ok: false, error: "invalid_transition", code: 409 };
    if (!o.location_city) return { ok: false, error: "merchant_location_missing", code: 409 };
    await releaseJobForOrder(q, orderId, "cancelled");
    await q(
      `UPDATE local_orders SET courier_id = NULL, dispatch_status = 'none', updated_at = now() WHERE id = $1`,
      [orderId],
    );
    return { ok: true, city: o.location_city, lat: o.location_lat, lng: o.location_lng };
  });
  if (!res.ok) return res;
  const old = await getJobForOrder(orderId);
  if (old) await publishJobEvent(old.id, { type: "status", status: "reassigned" });
  await createJob({ kind: "delivery", orderId, city: res.city as string, pickupLat: res.lat, pickupLng: res.lng });
  return { ok: true, status: "searching" };
}
