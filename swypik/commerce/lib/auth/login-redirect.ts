/**
 * Linkul către login pentru o pagină localizată. Paginile de autentificare
 * trăiesc DOAR fără prefix de limbă (`/auth`), deci `redirect({ href: "/auth",
 * locale: "en" })` din next-intl ducea la `/en/auth` → 404. Aici `/auth` rămâne
 * fără prefix, iar `next` păstrează limba paginii (`/en/inbox`).
 */
import { normalizeLocale } from "@/lib/email/i18n";
import { localizedPath } from "@/lib/email/links";

export function loginHref(locale: string, returnPath: string): string {
  const target = localizedPath(normalizeLocale(locale), returnPath);
  return `/auth?next=${encodeURIComponent(target)}`;
}
