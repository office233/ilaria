// Centralized i18n + currency config (Sprint 1 → extins 7 limbi).
// Locale-fără-routing: stocăm preferința în cookie (`swypik_locale`)
// și expunem catalogul corespunzător prin next-intl/server (lib/i18n/request.ts).

export const LOCALES = ["ro", "en", "es", "fr", "de", "pt", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ro";

export const LOCALE_COOKIE = "swypik_locale";
export const CURRENCY_COOKIE = "swypik_currency";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export const CURRENCIES = ["RON", "EUR", "USD", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];
// 2026-08-10 (audit P1): moneda implicită a platformei — configurabilă prin env
// (PLATFORM_DEFAULT_CURRENCY), cu fallback RON. Sursa de adevăr pentru toate
// default-urile de monedă din server/DB.
export const DEFAULT_CURRENCY: Currency = ((): Currency => {
  const raw = (process.env.NEXT_PUBLIC_DEFAULT_CURRENCY || process.env.PLATFORM_DEFAULT_CURRENCY || "").toUpperCase();
  return (CURRENCIES as readonly string[]).includes(raw) ? (raw as Currency) : "RON";
})();

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

// Locale implicit per țară (până avem geo-IP real).
export const LOCALE_BY_COUNTRY: Record<string, Locale> = {
  RO: "ro",
  MD: "ro",
  GB: "en",
  US: "en",
  IE: "en",
  ES: "es",
  MX: "es",
  AR: "es",
  FR: "fr",
  BE: "fr",
  DE: "de",
  AT: "de",
  CH: "de",
  PT: "pt",
  BR: "pt",
  IT: "it",
};

// Currency implicit per locale.
export const CURRENCY_BY_LOCALE: Record<Locale, Currency> = {
  ro: "RON",
  en: "GBP",
  es: "EUR",
  fr: "EUR",
  de: "EUR",
  pt: "EUR",
  it: "EUR",
};
