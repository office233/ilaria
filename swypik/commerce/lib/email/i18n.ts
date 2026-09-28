/**
 * Traduceri pentru emailuri și pentru răspunsurile API de autentificare,
 * utilizabile în afara unei cereri (cron, webhook-uri): mesajele se încarcă
 * direct din `messages/<locale>.json` și se traduc cu `createTranslator`.
 */
import { createTranslator } from "next-intl";
import { dbQuery } from "@/lib/db";
import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n/config";

type Messages = Record<string, unknown>;
const cache = new Map<Locale, Promise<Messages>>();

export function loadMessages(locale: Locale): Promise<Messages> {
  let p = cache.get(locale);
  if (!p) {
    p = import(`../../messages/${locale}.json`).then((m) => (m.default ?? m) as Messages);
    cache.set(locale, p);
  }
  return p;
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Traducător pentru un namespace (ex. `email`, `authEmail.errors`). */
export async function translator(locale: Locale, namespace: string): Promise<Translate> {
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages, namespace: namespace as never });
  return (key, values) => (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Limba destinatarului după id (users.locale), fallback ro. */
export async function localeForUser(userId: string | null | undefined): Promise<Locale> {
  if (!userId) return DEFAULT_LOCALE;
  try {
    const { rows } = await dbQuery<{ locale: string | null }>(`SELECT locale FROM users WHERE id = $1::uuid`, [userId]);
    return normalizeLocale(rows[0]?.locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Limba destinatarului după email (cont existent), fallback ro. */
export async function localeForEmail(email: string | null | undefined): Promise<Locale> {
  if (!email || !email.includes("@")) return DEFAULT_LOCALE;
  try {
    const { rows } = await dbQuery<{ locale: string | null }>(
      `SELECT locale FROM users WHERE email IS NOT NULL AND lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    return normalizeLocale(rows[0]?.locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Limba unei cereri HTTP: `explicit` (din body) → cookie `swypik_locale` →
 * prefixul din Referer (`/en/...`) → Accept-Language → ro.
 */
export function localeFromRequest(req: Request, explicit?: unknown): Locale {
  if (isLocale(explicit)) return explicit;
  const cookieLocale = parseCookie(req.headers.get("cookie"), LOCALE_COOKIE);
  if (isLocale(cookieLocale)) return cookieLocale;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const seg = new URL(referer).pathname.split("/")[1];
      if (isLocale(seg)) return seg;
    } catch {
      // Referer malformat — ignorăm
    }
  }
  const accept = req.headers.get("accept-language");
  const code = accept?.split(",")[0]?.trim().slice(0, 2).toLowerCase();
  if (code && (LOCALES as readonly string[]).includes(code)) return code as Locale;
  return DEFAULT_LOCALE;
}
