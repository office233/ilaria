/**
 * „Comandă nouă" către restaurant (audit food-go #7): înainte restaurantul afla
 * doar din polling-ul de 10 s cu panoul deschis. Push (lib/push prin
 * lib/dispatch/push-i18n, în limba contului sellerului) — o singură dată per
 * comandă (merchant_notified_at): cash la plasare, card după autorizarea hold-ului.
 * Emailul de comandă nouă e cerut grupului auth-email (template-uri).
 * Best-effort: nu aruncă.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendMobilityPush } from "@/lib/dispatch/push-i18n";

export async function notifyMerchantNewOrder(orderId: string): Promise<boolean> {
  try {
    const { rows } = await dbQuery<{ order_number: string; user_id: string | null }>(
      `UPDATE local_orders lo
          SET merchant_notified_at = now()
         FROM local_merchants m
         LEFT JOIN sellers s ON s.id = m.seller_id
        WHERE lo.id = $1 AND m.id = lo.merchant_id AND lo.merchant_notified_at IS NULL
          AND lo.status = 'placed'
          AND (lo.payment_method <> 'card_online' OR lo.payment_authorized_at IS NOT NULL OR lo.payment_status = 'paid')
        RETURNING lo.order_number, s.user_id`,
      [orderId],
    );
    const row = rows[0];
    if (!row?.user_id) return false;
    await sendMobilityPush(row.user_id, "merchantNewOrder", {
      url: "/seller/merchant",
      tag: `merchant-order-${orderId}`,
      vars: { number: row.order_number },
    });
    return true;
  } catch (err) {
    logger.warn({ err, orderId }, "[food/merchant-notify] failed");
    return false;
  }
}
