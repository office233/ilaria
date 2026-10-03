// Formatting unic pentru prețuri în cents.
// Reguli: stocăm price_cents + currency în DB; la afișare convertim în currency-ul
// preferat al user-ului folosind FX_RATES, apoi formatăm cu Intl.NumberFormat.

import { type Currency, type Locale, DEFAULT_CURRENCY, DEFAULT_LOCALE } from "./config";
import { convertCents } from "./fx";

const INTL_LOCALE: Record<Locale, string> = {
  ro: "ro-RO",
  en: "en-GB",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-PT",
  it: "it-IT",
};

export interface FormatCurrencyOptions {
  locale?: Locale;
  /** Currency-ul user-ului (display). Default = currency-ul sursă (no-op). */
  displayCurrency?: Currency;
  /** Currency-ul în care sunt stocate cents-urile sursă. */
  sourceCurrency?: Currency;
  /** Afișează zecimalele (default true). */
  showDecimals?: boolean;
}

export function formatCurrency(
  amountCents: number,
  options: FormatCurrencyOptions = {},
): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const sourceCurrency = options.sourceCurrency ?? DEFAULT_CURRENCY;
  const displayCurrency = options.displayCurrency ?? sourceCurrency;
  const showDecimals = options.showDecimals ?? true;

  const convertedCents = convertCents(amountCents, sourceCurrency, displayCurrency);
  const amount = convertedCents / 100;

  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency: displayCurrency,
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(amount);
}

/** Helper pentru cazuri legacy (RON whole units). */
export function formatPriceLegacy(
  amount: number,
  options: FormatCurrencyOptions = {},
): string {
  return formatCurrency(Math.round(amount * 100), options);
}

/**
 * Formatare pentru sume cu currency dinamic (din DB / Stripe), fără conversie FX.
 * Folosit pe server (email-uri, API) sau când currency-ul nu e din CURRENCIES.
 */
export function formatMoneyCents(
  cents: number | null | undefined,
  currency: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const cur = (currency || DEFAULT_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat(INTL_LOCALE[locale] ?? "ro-RO", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}
