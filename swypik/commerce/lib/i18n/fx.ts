// Cursuri valutare pentru afișarea prețurilor (1 RON -> X TARGET).
//
// Sursa reală = tabela `fx_rates`, populată zilnic de `cron/refresh-fx` și
// expusă clientului prin `GET /api/fx`. Valorile de mai jos sunt DOAR un
// fallback de siguranță pentru primul render / cazul în care API-ul pică;
// pot fi suprascrise la runtime cu `setFxRates()` (vezi FxRatesProvider).
//
// FIX 2026-07-31: înainte acestea erau singura sursă de adevăr — prețurile în
// EUR/USD/GBP erau calculate cu cursuri înghețate în cod.

import type { Currency } from "./config";

export const FX_BASE: Currency = "RON";

/** Fallback static (aproximativ). Nu folosi direct — vezi `getFxRates()`. */
const FALLBACK_RATES: Record<Currency, number> = {
  RON: 1,
  EUR: 0.2, // 1 RON ≈ 0.20 EUR (5 RON / EUR)
  USD: 0.22,
  GBP: 0.17,
};

let liveRates: Record<Currency, number> | null = null;

/** Setează cursurile primite de la `/api/fx` (apelat o dată, la mount). */
export function setFxRates(rates: Partial<Record<Currency, number>>): void {
  const next = { ...FALLBACK_RATES };
  for (const [k, v] of Object.entries(rates)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      next[k as Currency] = v;
    }
  }
  liveRates = next;
}

/** Cursurile în vigoare: live dacă au fost încărcate, altfel fallback. */
export function getFxRates(): Record<Currency, number> {
  return liveRates ?? FALLBACK_RATES;
}

/** @deprecated Folosește `getFxRates()` — acesta e doar fallback-ul static. */
export const FX_RATES = FALLBACK_RATES;

export function convertCents(
  amountCents: number,
  fromCurrency: Currency,
  toCurrency: Currency,
): number {
  if (fromCurrency === toCurrency) return amountCents;
  // 1) convert from -> RON (base)
  const rates = getFxRates();
  const fromRate = rates[fromCurrency];
  const toRate = rates[toCurrency];
  if (!fromRate || !toRate) return amountCents;
  const baseCents = amountCents / fromRate;
  return Math.round(baseCents * toRate);
}
