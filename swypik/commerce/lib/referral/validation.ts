/**
 * Validarea referral-ului la prima tranzacție reală plătită de invitat.
 *
 * Mutat din fostele hook-uri de recompense când sistemul de puncte a fost eliminat
 * (2026-09-25): validarea rămâne ca tracking de atribuire — FĂRĂ nicio
 * recompensă. Contorul total_validated e incrementat de trigger-ul
 * trg_referral_attr_counters (migrarea 20260519_0013).
 *
 * Toate funcțiile sunt best-effort: nu aruncă niciodată și nu blochează
 * fluxul de plată.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export type PaidContext = "shop_order" | "go_ride" | "eats_order" | "stay_booking" | "other";

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, hook: label }, "referral.validation.failed");
  }
}

/**
 * Marchează referral-ul invitatului ca validat la prima plată reală.
 * `UPDATE ... WHERE validated_at IS NULL` e poarta atomică: două plăți
 * confirmate simultan validează o singură dată.
 */
export async function onUserPaidTransaction(
  inviteeUserId: string | null,
  paidTxRef: string,
  context: PaidContext,
): Promise<void> {
  if (!inviteeUserId) return; // plată ca oaspete — fără cont, fără referral
  await safe(`paid_tx:${context}`, async () => {
    const { rows } = await dbQuery<{ referrer_user_id: string }>(
      `UPDATE referral_attributions
          SET validated_at = now(), validation_action = $2
        WHERE invitee_user_id = $1 AND validated_at IS NULL
        RETURNING referrer_user_id::text`,
      [inviteeUserId, `first_paid:${context}`],
    );
    const referrerId = rows[0]?.referrer_user_id;
    if (referrerId) {
      logger.info({ referrerId, inviteeId: inviteeUserId, context, paidTxRef }, "referral.validated");
    }
  });
}

/** Comandă din Shop plătită. */
export async function onOrderPaid(orderId: string, paidTxRef: string): Promise<void> {
  await safe("order_paid", async () => {
    const { rows } = await dbQuery<{ buyer_user_id: string | null }>(
      `SELECT buyer_user_id::text FROM commerce_orders WHERE id = $1`,
      [orderId],
    );
    await onUserPaidTransaction(rows[0]?.buyer_user_id ?? null, paidTxRef, "shop_order");
  });
}

/** Cursă Swypik Go plătită (card capturat sau cash încasat). */
export async function onRidePaid(rideId: string, paidTxRef: string): Promise<void> {
  await safe("ride_paid", async () => {
    const { rows } = await dbQuery<{ rider_user_id: string | null }>(
      `SELECT rider_user_id::text FROM rides WHERE id = $1`,
      [rideId],
    );
    await onUserPaidTransaction(rows[0]?.rider_user_id ?? null, paidTxRef, "go_ride");
  });
}

/** Comandă Eats plătită. */
export async function onLocalOrderPaid(orderId: string, paidTxRef: string): Promise<void> {
  await safe("local_order_paid", async () => {
    const { rows } = await dbQuery<{ customer_user_id: string | null }>(
      `SELECT customer_user_id::text FROM local_orders WHERE id = $1`,
      [orderId],
    );
    await onUserPaidTransaction(rows[0]?.customer_user_id ?? null, paidTxRef, "eats_order");
  });
}
