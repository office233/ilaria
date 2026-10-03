"use client";

import { useLocale } from "next-intl";
import { useCurrency } from "@/components/i18n/CurrencyProvider";
import { formatCurrency, type FormatCurrencyOptions } from "@/lib/i18n/currency";
import type { Currency, Locale } from "@/lib/i18n/config";

/**
 * Hook client: returnează formatter pentru prețuri folosind locale + currency
 * preferat al user-ului. `sourceCurrency` indică în ce e stocată valoarea
 * (default RON — currency-ul intern al DB-ului).
 */
export function useFormatPrice() {
  const locale = useLocale() as Locale;
  const { currency } = useCurrency();

  return (
    amountCents: number,
    options: Omit<FormatCurrencyOptions, "locale" | "displayCurrency"> & {
      sourceCurrency?: Currency;
    } = {},
  ) =>
    formatCurrency(amountCents, {
      ...options,
      locale,
      displayCurrency: currency,
    });
}
