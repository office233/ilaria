/**
 * Notificare generică în layout-ul de brand, pentru module care își traduc
 * singure textele (Stays — `staysNotify`, aplicații creator —
 * `creatorApplicationEmail`). Textul e escapat; linkul e absolut și
 * localizat pentru destinatar. Tranzacțional (fără dezabonare).
 */
import type { Locale } from "@/lib/i18n/config";
import { localeForEmail, normalizeLocale } from "../i18n";
import { emailLink } from "../links";
import type { EmailBlock } from "../layout";
import { deliver, greeting, tr } from "./base";

export async function sendNoticeEmail(input: {
  to: string;
  subject: string;
  title: string;
  paragraphs: string[];
  /** Nume pentru salut (prenume), opțional. */
  name?: string | null;
  /** Citat/motiv evidențiat (ex. motivul unei respingeri). */
  quote?: { label: string; text: string } | null;
  cta?: { label: string; path: string } | null;
  locale?: Locale | string | null;
}): Promise<boolean> {
  const locale = input.locale ? normalizeLocale(input.locale) : await localeForEmail(input.to);
  const x = await tr(locale, "common");
  const blocks: EmailBlock[] = [];
  if (input.name !== undefined) blocks.push(greeting(x.tc, input.name));
  for (const p of input.paragraphs) if (p.trim()) blocks.push({ type: "p", text: p });
  if (input.quote?.text) blocks.push({ type: "box", label: input.quote.label, text: input.quote.text, tone: "danger" });
  if (input.cta) blocks.push({ type: "button", label: input.cta.label, href: emailLink(locale, input.cta.path) });
  return deliver({ to: input.to, subject: input.subject, title: input.title, tr: x, blocks });
}
