/**
 * Configurația de email — o singură sursă pentru expeditor, reply-to și
 * detectarea cheilor placeholder.
 *
 *   EMAIL_FROM      — expeditorul (implicit `Swypik <noreply@swypik.com>`)
 *   EMAIL_REPLY_TO  — unde ajung răspunsurile clienților (implicit SUPPORT_EMAIL),
 *                     ca un răspuns la un email tranzacțional să nu se piardă
 *                     într-o căsuță no-reply.
 *   RESEND_API_KEY  — cheia Resend; o valoare placeholder (prod, decizia
 *                     owner-ului) înseamnă „email neconfigurat", nu succes fals.
 */
import { SUPPORT_EMAIL } from "@/lib/contact";

export const DEFAULT_EMAIL_FROM = "Swypik <noreply@swypik.com>";

export function emailFrom(): string {
  const v = process.env.EMAIL_FROM?.trim();
  return v ? v : DEFAULT_EMAIL_FROM;
}

export function emailReplyTo(): string {
  const v = process.env.EMAIL_REPLY_TO?.trim();
  return v ? v : SUPPORT_EMAIL;
}

const PLACEHOLDER_RE = /placeholder|changeme|change_me|your[_-]|xxxx|dummy|example|^re_test_?$|^todo$/i;

/** True pentru chei goale sau evident de umplutură (`placeholder`, `re_xxx`, `changeme`…). */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  const v = (value ?? "").trim();
  if (!v) return true;
  return PLACEHOLDER_RE.test(v);
}
