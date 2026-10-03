/**
 * Notificări in-app traduse în limba destinatarului (users.locale), în loc de
 * texte românești hardcodate. Titlul/corpul vin din `messages/<locale>.json`,
 * namespace-ul `notificationsText`.
 */
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { routing } from "@/lib/i18n/routing";
import { notifyUser, type NotificationType } from "./dispatch";

export type LocalizedNotice =
  | "creatorApproved"
  | "creatorRejected"
  | "missionWinner"
  | "missionRejected"
  | "creatorPayoutPaid"
  | "creatorPayoutRejected"
  | "videoHidden"
  | "videoRemoved"
  | "videoRejected"
  | "accountSuspended";

export async function userLocale(userId: string): Promise<string> {
  const { rows } = await dbQuery<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1`, [userId]);
  const loc = rows[0]?.locale ?? routing.defaultLocale;
  return (routing.locales as readonly string[]).includes(loc) ? loc : routing.defaultLocale;
}

/** Best-effort: o notificare eșuată nu blochează acțiunea care a declanșat-o. */
export async function notifyLocalized(
  userId: string,
  notice: LocalizedNotice,
  opts: { url: string; values?: Record<string, string | number>; type?: NotificationType; extra?: Record<string, unknown> },
): Promise<void> {
  try {
    const locale = await userLocale(userId);
    const t = await getTranslations({ locale, namespace: "notificationsText" });
    await notifyUser(userId, {
      type: opts.type ?? "system",
      payload: {
        ...opts.extra,
        notice,
        title: t(`${notice}.title`, opts.values),
        body: t(`${notice}.body`, opts.values),
        url: opts.url,
      },
    });
  } catch (err) {
    logger.warn({ err, userId, notice }, "notifications.localized.failed");
  }
}
