/**
 * Linkuri absolute din emailuri: mereu `APP_URL` (https://swypik.com în
 * producție) + prefixul de limbă al destinatarului (`as-needed`: ro fără
 * prefix, restul `/en`, `/de`…). Rutele fără variantă localizată (auth,
 * seller, creator, courier, unsubscribe…) — aceeași listă ca în middleware —
 * nu primesc prefix, altfel ar da 404.
 */
import { APP_URL } from "@/lib/app-url";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";

const NON_LOCALIZED = [
  "/api",
  "/admin",
  "/seller",
  "/auth",
  "/onboarding",
  "/creator",
  "/unsubscribe",
  "/r",
  "/courier",
  "/cauze",
];

export function isNonLocalizedPath(path: string): boolean {
  return NON_LOCALIZED.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
}

/** Calea (fără origine) cu prefixul limbii, pentru rutele localizate. */
export function localizedPath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE || isNonLocalizedPath(clean)) return clean;
  return clean === "/" ? `/${locale}` : `/${locale}${clean}`;
}

/** URL absolut pentru un email. `query` e adăugat encodat. */
export function emailLink(locale: Locale, path: string, query?: Record<string, string>): string {
  const url = new URL(`${APP_URL}${localizedPath(locale, path)}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}
