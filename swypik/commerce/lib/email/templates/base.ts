/** Utilitare comune șabloanelor: traducători + trimiterea unui conținut randat. */
import type { Locale } from "@/lib/i18n/config";
import { translator, type Translate } from "../i18n";
import { renderEmail, type EmailBlock } from "../layout";
import { sendRendered } from "../send";
import { unsubscribeUrl } from "../unsubscribe";

export type Tr = { t: Translate; tc: Translate; locale: Locale };

export async function tr(locale: Locale, section: string): Promise<Tr> {
  const [t, tc] = await Promise.all([translator(locale, `email.${section}`), translator(locale, "email.common")]);
  return { t, tc, locale };
}

export function greeting(tc: Translate, name?: string | null): EmailBlock {
  const n = (name ?? "").trim();
  return { type: "p", text: n ? tc("hello", { name: n }) : tc("helloNoName") };
}

export async function deliver(args: {
  to: string;
  subject: string;
  title: string;
  blocks: EmailBlock[];
  tr: Tr;
  preheader?: string;
  marketing?: boolean;
}): Promise<boolean> {
  const { tr: x } = args;
  const rendered = renderEmail(
    {
      locale: x.locale,
      title: args.title,
      preheader: args.preheader,
      blocks: args.blocks,
      ...(args.marketing ? { unsubscribeUrl: unsubscribeUrl(args.to, x.locale) } : {}),
    },
    x.tc,
  );
  return sendRendered({ to: args.to, subject: args.subject, rendered, marketing: args.marketing });
}

/** Sumă de bani în limba destinatarului (din cenți). */
export function money(locale: Locale, cents: number, currency: string): string {
  const cur = (currency || "RON").toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: cur }).format(Math.max(0, cents) / 100);
  } catch {
    return `${(Math.max(0, cents) / 100).toFixed(2)} ${cur}`;
  }
}

export function shortOrderNumber(orderId: string): string {
  return String(orderId).split("-")[0].toUpperCase();
}
