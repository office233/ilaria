/** Formatare comună pentru paginile publice de misiuni (sume în bani RON). */

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function formatRon(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "RON" }).format(cents / 100);
}

export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

/** „3 zile rămase” / „5 ore rămase” / „Fără termen” — plural ICU din `missionsHub.remaining`. */
export function remainingLabel(t: Translate, endsAt: string | null, now: number = Date.now()): string {
  if (!endsAt) return t("remaining.none");
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return t("remaining.ended");
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return t("remaining.days", { count: days });
  return t("remaining.hours", { count: Math.max(1, Math.floor(ms / 3_600_000)) });
}
