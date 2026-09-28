/**
 * Watchdog Swypik Food (audit food-go #7) — rulat de /api/cron/food-orders-watchdog:
 *
 *  1. comenzi cu cardul 'placed' fără hold confirmat în DB → verificare la Stripe
 *     (plasă dacă clientul a închis pagina după confirmPayment); dacă hold-ul
 *     există, restaurantul primește acum push-ul „comandă nouă";
 *  2. comenzi 'placed' neacceptate după FOOD_PLACED_TIMEOUT_MIN (implicit 15)
 *     → anulate de sistem, cu refund / eliberarea hold-ului și push către client;
 *  3. comenzi blocate după acceptare (accepted → delivering) fără mișcare de
 *     FOOD_STALE_ACTIVE_MIN (implicit 120) → doar raportate (consola /admin/go).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { transitionOrder } from "./transition";
import { runTransitionEffects } from "./transition-effects";
import { syncLocalOrderAuthorization } from "./card-payment";
import { notifyMerchantNewOrder } from "./merchant-notify";

const log = logger.child({ mod: "food/watchdog" });

function envMinutes(name: string, fallback: number, max = 1440): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 && n <= max ? Math.trunc(n) : fallback;
}

export const placedTimeoutMinutes = () => envMinutes("FOOD_PLACED_TIMEOUT_MIN", 15);
export const staleActiveMinutes = () => envMinutes("FOOD_STALE_ACTIVE_MIN", 120, 2880);

const BATCH = 50;

export type FoodWatchdogResult = {
  card_synced: number;
  auto_cancelled: number;
  stale_active_reported: number;
};

export async function runFoodWatchdog(): Promise<FoodWatchdogResult> {
  // 1) Hold-uri confirmate la Stripe dar nesincronizate în DB.
  const { rows: pendingCard } = await dbQuery<{ id: string }>(
    `SELECT id FROM local_orders
      WHERE status = 'placed' AND payment_method = 'card_online' AND payment_status = 'pending'
        AND payment_authorized_at IS NULL AND payment_intent_id IS NOT NULL
        AND placed_at > now() - make_interval(mins => $1)
      ORDER BY placed_at LIMIT $2`,
    [placedTimeoutMinutes(), BATCH],
  );
  let synced = 0;
  for (const o of pendingCard) {
    const state = await syncLocalOrderAuthorization(o.id);
    if (state === "authorized" || state === "paid") {
      synced += 1;
      await notifyMerchantNewOrder(o.id);
    }
  }

  // 2) Neacceptate la timp → anulare sistem + refund.
  const { rows: stale } = await dbQuery<{ id: string }>(
    `SELECT id FROM local_orders
      WHERE status = 'placed' AND placed_at < now() - make_interval(mins => $1)
      ORDER BY placed_at LIMIT $2`,
    [placedTimeoutMinutes(), BATCH],
  );
  let cancelled = 0;
  for (const o of stale) {
    try {
      const r = await transitionOrder({
        orderId: o.id,
        to: "cancelled",
        actor: "system",
        reason: "merchant_timeout",
        authorize: () => true,
      });
      if (!r.ok) continue;
      await runTransitionEffects({
        orderId: o.id,
        status: "cancelled",
        customerUserId: r.customerUserId,
        merchantName: r.merchantName,
        reason: "merchant_timeout",
      });
      cancelled += 1;
    } catch (err) {
      log.error({ err, orderId: o.id }, "auto-cancel failed");
    }
  }

  // 3) Blocate după acceptare → raportare (acțiunea o ia dispeceratul).
  const { rows: stuck } = await dbQuery<{ id: string; status: string }>(
    `SELECT id, status FROM local_orders
      WHERE status IN ('accepted', 'preparing', 'ready', 'picked_up', 'delivering')
        AND updated_at < now() - make_interval(mins => $1)
      LIMIT $2`,
    [staleActiveMinutes(), BATCH],
  );
  if (stuck.length) log.warn({ count: stuck.length, ids: stuck.map((s) => s.id) }, "food orders stuck — check /admin/go");

  return { card_synced: synced, auto_cancelled: cancelled, stale_active_reported: stuck.length };
}
