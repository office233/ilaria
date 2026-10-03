// next-intl request config — routing-aware version (Faza 1).
// Sursa adevărului pentru locale:
//   1. dacă URL-ul are prefix (/en, /de, …) → folosim prefixul (gestionat de
//      next-intl prin parametrul `requestLocale` derivat din `[locale]`)
//   2. fallback: cookie `swypik_locale` (selectorul globe + setări utilizator)
//   3. fallback: locale-ul utilizatorului din DB (users.locale)
//   4. fallback: Accept-Language header
//   5. fallback final: DEFAULT_LOCALE (ro)
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";
import { DEFAULT_TIMEZONE } from "@/lib/config/timezone";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALES,
  isLocale,
  type Locale,
} from "./config";

function parseAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const first = header.split(",")[0]?.trim().toLowerCase() ?? "";
  const code = first.slice(0, 2);
  return (LOCALES as readonly string[]).includes(code) ? (code as Locale) : null;
}

async function resolveUserLocale(): Promise<Locale | null> {
  try {
    const { getAuthUser } = await import("@/lib/auth/getAuthUser");
    const { dbQuery } = await import("@/lib/db");
    const auth = await getAuthUser();
    if (!auth.userId) return null;
    const { rows } = await dbQuery<{ locale: string | null }>(
      `SELECT locale FROM users WHERE id = $1 LIMIT 1`,
      [auth.userId],
    );
    const v = rows[0]?.locale;
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

export default getRequestConfig(async ({ locale: explicitLocale, requestLocale }) => {
  // 0) Locale explicit (`getTranslations({ locale })`, ex. în generateMetadata,
  //    care rulează ÎNAINTE de setRequestLocale din layout). Fără el,
  //    `requestLocale` ar citi header-ul middleware-ului → pagină dinamică.
  let locale: Locale | null = isLocale(explicitLocale) ? explicitLocale : null;

  // 1) URL-prefix locale (`/en/...` etc.) — din setRequestLocale([locale]);
  //    abia fără el next-intl cade pe header-ul setat de middleware.
  if (!locale) {
    const fromUrl = await requestLocale;
    if (isLocale(fromUrl)) locale = fromUrl;
  }

  // 2) Cookie fallback (utilizatori pe `/` fără prefix)
  if (!locale) {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
    if (isLocale(cookieLocale)) locale = cookieLocale;
  }

  // 3) DB fallback (utilizatori autentificați)
  if (!locale) locale = await resolveUserLocale();

  // 4) Accept-Language fallback
  if (!locale) {
    const headerStore = await headers();
    locale = parseAcceptLanguage(headerStore.get("accept-language"));
  }

  // 5) Default
  if (!locale) locale = DEFAULT_LOCALE;
  // Validare finală (apărare contra valori corupte sau locale-uri necunoscute)
  if (!routing.locales.includes(locale as never)) locale = DEFAULT_LOCALE;

  const messages = (await import(`../../messages/${locale}.json`)).default;

  return {
    locale,
    messages,
    timeZone: DEFAULT_TIMEZONE,
  };
});
