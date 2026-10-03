/** Formatare bani/date pentru panoul seller-ului (fără monedă scrisă în cod). */

export function formatSellerMoney(locale: string, cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.trim() || "RON" }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatSellerDate(locale: string, iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(d);
}

/** Id scurt de comandă, afișat utilizatorului. */
export function shortOrderId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}
