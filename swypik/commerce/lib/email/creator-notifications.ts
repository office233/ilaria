/**
 * Emailuri tranzacționale pentru creatori: decizia de moderare pe clip și
 * confirmarea plății. NU depind de FEATURE_EMAIL_MARKETING și nu au footer
 * de dezabonare. Comisionul afișat vine din config (CREATOR_COMMISSION_BPS).
 */
import { CREATOR_COMMISSION_BPS } from "@/lib/config/commerce";
import { localeForEmail } from "./i18n";
import { emailLink } from "./links";
import { deliver, greeting, tr } from "./templates/base";

function percent(locale: string, bps: number): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(bps / 10_000);
}

export async function notifyVideoApproved(creatorEmail: string, creatorName: string, videoTitle: string): Promise<boolean> {
  const locale = await localeForEmail(creatorEmail);
  const x = await tr(locale, "creator");
  return deliver({
    to: creatorEmail,
    subject: x.t("approvedSubject"),
    title: x.t("approvedTitle"),
    tr: x,
    blocks: [
      greeting(x.tc, creatorName),
      { type: "p", text: x.t("approvedBody", { title: videoTitle, rate: percent(locale, CREATOR_COMMISSION_BPS) }) },
      { type: "button", label: x.t("approvedCta"), href: emailLink(locale, "/creator/videos") },
    ],
  });
}

export async function notifyVideoRejected(
  creatorEmail: string,
  creatorName: string,
  videoTitle: string,
  reason: string,
): Promise<boolean> {
  const locale = await localeForEmail(creatorEmail);
  const x = await tr(locale, "creator");
  return deliver({
    to: creatorEmail,
    subject: x.t("rejectedSubject"),
    title: x.t("rejectedTitle"),
    tr: x,
    blocks: [
      greeting(x.tc, creatorName),
      { type: "p", text: x.t("rejectedBody", { title: videoTitle }) },
      ...(reason ? [{ type: "box" as const, label: x.t("reason"), text: reason, tone: "danger" as const }] : []),
      { type: "p", text: x.t("rejectedRetry") },
      { type: "button", label: x.t("rejectedCta"), href: emailLink(locale, "/upload") },
    ],
  });
}

/** `amount` e deja formatat de apelant (sumă + monedă). */
export async function notifyPayoutSent(creatorEmail: string, creatorName: string, amount: string): Promise<boolean> {
  const locale = await localeForEmail(creatorEmail);
  const x = await tr(locale, "creator");
  return deliver({
    to: creatorEmail,
    subject: x.t("payoutSubject", { amount }),
    title: x.t("payoutTitle"),
    tr: x,
    blocks: [
      greeting(x.tc, creatorName),
      { type: "p", text: x.t("payoutBody", { amount }) },
      { type: "button", label: x.t("payoutCta"), href: emailLink(locale, "/creator/earnings") },
    ],
  });
}
