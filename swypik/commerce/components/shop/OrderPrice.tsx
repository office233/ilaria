"use client";

import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { Currency } from "@/lib/i18n/config";

/** Preț formatat în moneda preferată a utilizatorului (folosibil din pagini server). */
export function OrderPrice({ cents, currency, negative = false }: { cents: number; currency: string; negative?: boolean }) {
  const formatPrice = useFormatPrice();
  const value = formatPrice(cents, { sourceCurrency: currency as Currency });
  return <>{negative ? `−${value}` : value}</>;
}
