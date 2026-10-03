/**
 * Push către client la schimbarea statusului unei comenzi Food — în limba
 * clientului (users.locale), texte din namespace-ul i18n `foodPush`.
 * Înainte: texte românești hardcodate cu emoji în ruta de status.
 * Best-effort: nu aruncă.
 */
import { createTranslator } from "next-intl";
import { dbQuery } from "@/lib/db";
import { sendPushToUser } from "@/lib/push/send";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";

const PUSH_STATUSES = new Set([
  "accepted", "rejected", "preparing", "ready", "picked_up", "delivering", "delivered", "cancelled",
]);

async function userLocale(userId: string): Promise<string> {
  const { rows } = await dbQuery<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1`, [userId]);
  const l = rows[0]?.locale;
  return isLocale(l) ? l : DEFAULT_LOCALE;
}

export async function notifyCustomerOrderStatus(args: {
  orderId: string;
  customerUserId: string | null;
  merchantName: string;
  status: string;
  refunded?: boolean;
}): Promise<void> {
  if (!args.customerUserId || !PUSH_STATUSES.has(args.status)) return;
  try {
    const locale = await userLocale(args.customerUserId);
    const messages = (await import(`../../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: "foodPush" });
    const bodyKey = args.status === "cancelled" || args.status === "rejected"
      ? (args.refunded ? `${args.status}_refunded_body` : `${args.status}_body`)
      : `${args.status}_body`;
    await sendPushToUser(args.customerUserId, {
      title: t(`${args.status}_title` as never),
      body: `${args.merchantName} · ${t(bodyKey as never)}`,
      url: `/food/orders/${args.orderId}`,
      tag: `eats-order-${args.orderId}`,
    });
  } catch (err) {
    logger.warn({ err, orderId: args.orderId }, "[food/notify] push failed");
  }
}
