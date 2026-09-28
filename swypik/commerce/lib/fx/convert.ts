import { dbQuery } from "@/lib/db";

type CacheEntry = { rate: number; ts: number };
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function key(base: string, quote: string) {
  return `${base.toUpperCase()}->${quote.toUpperCase()}`;
}

/**
 * Get FX rate from `base` to `quote`. Reads from fx_rates table with
 * in-memory cache of 5 minutes. Returns 1 if base === quote. Returns
 * NaN if rate not available.
 */
export async function getRate(quote: string, base = "EUR"): Promise<number> {
  const Q = quote.toUpperCase();
  const B = base.toUpperCase();
  if (Q === B) return 1;

  const k = key(B, Q);
  const now = Date.now();
  const hit = cache.get(k);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.rate;

  // Direct row
  const { rows } = await dbQuery<{ rate: string }>(
    `SELECT rate::text AS rate FROM fx_rates WHERE base = $1 AND quote = $2 LIMIT 1`,
    [B, Q],
  );
  if (rows.length > 0) {
    const rate = Number(rows[0].rate);
    if (isFinite(rate) && rate > 0) {
      cache.set(k, { rate, ts: now });
      return rate;
    }
  }

  // Inverse fallback
  const inv = await dbQuery<{ rate: string }>(
    `SELECT rate::text AS rate FROM fx_rates WHERE base = $1 AND quote = $2 LIMIT 1`,
    [Q, B],
  );
  if (inv.rows.length > 0) {
    const r = Number(inv.rows[0].rate);
    if (isFinite(r) && r > 0) {
      const rate = 1 / r;
      cache.set(k, { rate, ts: now });
      return rate;
    }
  }

  return NaN;
}

/**
 * Convert amount in minor units (cents) from `from` currency to `to` currency.
 * Returns rounded integer cents in the target currency.
 */
export async function convert(amountCents: number, from: string, to: string): Promise<number> {
  if (!isFinite(amountCents)) return 0;
  const F = from.toUpperCase();
  const T = to.toUpperCase();
  if (F === T) return Math.round(amountCents);

  // Route via EUR if neither side is EUR.
  if (F !== "EUR" && T !== "EUR") {
    const fromToEur = await getRate(F, "EUR"); // EUR -> F rate; we need to invert
    // getRate("F","EUR") returns EUR->F. To convert F to EUR: divide by it.
    if (!isFinite(fromToEur) || fromToEur <= 0) return Number.NaN;
    const eurCents = amountCents / fromToEur;
    const eurToTarget = await getRate(T, "EUR");
    if (!isFinite(eurToTarget) || eurToTarget <= 0) return Number.NaN;
    return Math.round(eurCents * eurToTarget);
  }

  if (F === "EUR") {
    const rate = await getRate(T, "EUR");
    if (!isFinite(rate) || rate <= 0) return Number.NaN;
    return Math.round(amountCents * rate);
  }

  // T === EUR
  const rate = await getRate(F, "EUR");
  if (!isFinite(rate) || rate <= 0) return Number.NaN;
  return Math.round(amountCents / rate);
}
