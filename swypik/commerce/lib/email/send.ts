/**
 * Trimiterea efectivă a unui email Swypik.
 *
 *  - `sendRendered` — pentru șabloanele din lib/email/templates (au deja
 *    HTML + text în layout-ul de brand);
 *  - `sendEmail` — API-ul vechi `{ to, subject, html }`: un fragment HTML e
 *    învelit automat în layout, cu partea text/plain generată.
 *
 * Reguli comune:
 *  - fără provider real (cheie lipsă/placeholder) → `false` + log „email not
 *    configured", niciodată succes fals;
 *  - footer-ul și antetele de dezabonare apar DOAR la marketing;
 *  - marketingul nu pleacă spre adrese dezabonate.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Locale } from "@/lib/i18n/config";
import { sendMail, activeProvider } from "./transport";
import { maskEmail, oneLine } from "./escape";
import { translator, localeForEmail, normalizeLocale } from "./i18n";
import { fragmentTitle, htmlToText, renderEmail, type RenderedEmail } from "./layout";
import { oneClickUnsubscribeUrl, unsubscribeUrl } from "./unsubscribe";

const log = logger.child({ service: "email" });

export function emailReady(): boolean {
  return activeProvider() !== "none";
}

export async function isUnsubscribed(email: string): Promise<boolean> {
  try {
    const res = await dbQuery<{ ok: number }>(
      `SELECT 1 AS ok FROM email_unsubscribes WHERE email_lower = lower($1) LIMIT 1`,
      [email],
    );
    return (res.rows?.length || 0) > 0;
  } catch (e) {
    log.warn({ err: e }, "unsubscribes check failed");
    // Dacă nu putem verifica, nu riscăm să trimitem marketing unui dezabonat.
    return true;
  }
}

export type SendRenderedInput = {
  to: string;
  subject: string;
  rendered: RenderedEmail;
  marketing?: boolean;
  replyTo?: string;
};

export async function sendRendered(input: SendRenderedInput): Promise<boolean> {
  const to = String(input.to ?? "").trim();
  if (!to || !to.includes("@")) {
    log.warn({ to: maskEmail(to) }, "invalid recipient");
    return false;
  }
  if (input.marketing && (await isUnsubscribed(to))) {
    log.info({ to: maskEmail(to) }, "marketing email suppressed (unsubscribed)");
    return false;
  }
  if (!emailReady()) {
    log.warn({ to: maskEmail(to) }, "email not configured — mesaj netrimis");
    return false;
  }
  try {
    const headers = input.marketing
      ? {
          "List-Unsubscribe": `<${oneClickUnsubscribeUrl(to)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : undefined;
    const ok = await sendMail({
      to,
      subject: oneLine(input.subject),
      html: input.rendered.html,
      text: input.rendered.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(headers ? { headers } : {}),
    });
    if (!ok) {
      log.error({ to: maskEmail(to) }, "email send failed");
      return false;
    }
    log.info({ to: maskEmail(to) }, "email sent");
    return true;
  } catch (e) {
    log.error({ err: e, to: maskEmail(to) }, "email send error");
    return false;
  }
}

/** Curăță un fragment HTML moștenit (fără script/iframe/handler-e/javascript:). */
export function sanitizeFragment(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|meta|link|base)[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"');
}

export type LegacyEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  marketing?: boolean;
  locale?: Locale;
  replyTo?: string;
};

/**
 * API-ul vechi. Un document HTML complet (`<html`) e trimis ca atare (cu
 * text generat); un fragment e pus în layout-ul de brand, în limba
 * destinatarului (users.locale după email, sau `locale`).
 */
export async function sendEmail(params: LegacyEmailInput): Promise<boolean> {
  const to = String(params.to ?? "").trim();
  if (!to || !to.includes("@")) {
    log.warn({ to: maskEmail(to) }, "invalid recipient");
    return false;
  }
  if (!emailReady()) {
    log.warn({ to: maskEmail(to) }, "email not configured — mesaj netrimis");
    return false;
  }
  let rendered: RenderedEmail;
  if (/<html[\s>]/i.test(params.html)) {
    rendered = { html: params.html, text: params.text ?? htmlToText(params.html) };
  } else {
    const locale = params.locale ? normalizeLocale(params.locale) : await localeForEmail(to);
    const tc = await translator(locale, "email.common");
    const clean = sanitizeFragment(params.html);
    const { title, body } = fragmentTitle(clean, oneLine(params.subject));
    rendered = renderEmail(
      {
        locale,
        title,
        blocks: [{ type: "raw", html: body, text: params.text ?? htmlToText(body) }],
        ...(params.marketing ? { unsubscribeUrl: unsubscribeUrl(to, locale) } : {}),
      },
      tc,
    );
  }
  return sendRendered({ to, subject: params.subject, rendered, marketing: params.marketing, replyTo: params.replyTo });
}
