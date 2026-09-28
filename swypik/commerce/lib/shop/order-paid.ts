/**
 * Pașii magazinului după tranziția pending → paid (apelat din webhook-ul
 * Stripe, o singură dată per comandă — gard-ul RETURNING din handler):
 *  - eliberează rezervarea de stoc (stocul real a fost deja decrementat);
 *  - închide coșul din care a pornit comanda (status 'ordered');
 *  - notificare in-app către cumpărător, în limba lui.
 * Best-effort: nimic de aici nu are voie să pice webhook-ul.
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notifyUser } from "@/lib/notifications/dispatch";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";

export async function finalizePaidShopOrder(orderId: string): Promise<void> {
  try {
    const { rows } = await dbQuery<{ buyer_user_id: string | null; cart_id: string | null; locale: string | null }>(
      `UPDATE commerce_orders o
          SET reserved_until = NULL
        WHERE o.id = $1
        RETURNING o.buyer_user_id::text AS buyer_user_id,
                  o.metadata->>'cart_id' AS cart_id,
                  (SELECT u.locale FROM users u WHERE u.id = o.buyer_user_id) AS locale`,
      [orderId],
    );
    const order = rows[0];
    if (!order) return;

    if (order.cart_id) {
      await dbQuery(
        `UPDATE carts SET status = 'ordered', updated_at = now() WHERE id::text = $1 AND status = 'active'`,
        [order.cart_id],
      );
    }

    if (order.buyer_user_id) {
      const locale = isLocale(order.locale) ? order.locale : DEFAULT_LOCALE;
      const t = await getTranslations({ locale, namespace: "shopBuyer.notify" });
      await notifyUser(order.buyer_user_id, {
        type: "system",
        payload: {
          title: t("orderPaidTitle"),
          body: t("orderPaidBody", { order: orderId.slice(0, 8).toUpperCase() }),
          url: `/account/orders/${orderId}`,
          kind: "shop_order_paid",
          orderId,
        },
      });
    }
  } catch (err) {
    logger.error({ err, orderId }, "[shop] finalizarea comenzii plătite a eșuat");
  }
}
