import { CURRENCY_COOKIE, LOCALE_COOKIE, isCurrency, type Currency, type Locale } from "@/lib/i18n/config";

export function readCurrencyPreferenceCookie(cookie: string): Currency | null {
  const prefix = `${CURRENCY_COOKIE}=`;
  const entry = cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
  try {
    const value = entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
    return isCurrency(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persist locally even when the preference service is temporarily unavailable. */
export async function saveI18nPreference(preference: { locale?: Locale; currency?: Currency }): Promise<void> {
  try {
    for (const [name, value] of [[LOCALE_COOKIE, preference.locale], [CURRENCY_COOKIE, preference.currency]]) {
      if (value) document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }
  } catch {
    // Some browser privacy modes disable cookie writes; the UI can still change.
  }
  try {
    await fetch("/api/i18n/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preference),
    });
  } catch {
    // The first-party cookie already holds the user's choice for the next load.
  }
}
