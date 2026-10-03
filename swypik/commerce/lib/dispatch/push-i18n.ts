/**
 * Push-uri Food/Go în limba destinatarului (users.locale), texte din
 * namespace-ul i18n `mobilityPush` (audit food-go #23: înainte RO hardcodat).
 * Best-effort: nu aruncă niciodată.
 */
import { createTranslator } from "next-intl";
import { dbQuery } from "@/lib/db";
import { sendPushToUser } from "@/lib/push/send";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";

export type MobilityPushKey =
  | "newRide"
  | "newDelivery"
  | "driverFound"
  | "driverArriving"
  | "courierFound"
  | "merchantNewOrder";

type Vars = Record<string, string | number>;

async function userLocale(userId: string): Promise<string> {
  const { rows } = await dbQuery<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1`, [userId]);
  const l = rows[0]?.locale;
  return isLocale(l) ? l : DEFAULT_LOCALE;
}

export async function mobilityPushText(
  userId: string,
  key: MobilityPushKey,
  vars: Vars = {},
): Promise<{ title: string; body: string }> {
  const locale = await userLocale(userId);
  const messages = (await import(`../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace: "mobilityPush" });
  return { title: t(`${key}.title` as never, vars as never), body: t(`${key}.body` as never, vars as never) };
}

export async function sendMobilityPush(
  userId: string,
  key: MobilityPushKey,
  opts: { url: string; tag?: string; vars?: Vars },
): Promise<void> {
  try {
    const text = await mobilityPushText(userId, key, opts.vars);
    await sendPushToUser(userId, { ...text, url: opts.url, tag: opts.tag });
  } catch (err) {
    logger.warn({ err, key }, "[mobility-push] failed");
  }
}
