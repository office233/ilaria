/**
 * Formatare comună pentru contoare și timp relativ (client + server) — înlocuiește
 * cele trei copii locale `formatCount` (audit profiles-social §4).
 */

export function formatCount(value: number, locale: string): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (n < 1000) return String(n);
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

export type RelativeUnit = "now" | "minutes" | "hours" | "days" | "weeks";

/** Unitatea + valoarea pentru „acum / 5m / 3h / 2z / 4săpt" (textul îl dă i18n). */
export function relativeTime(iso: string, now: number = Date.now()): { unit: RelativeUnit; value: number } {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { unit: "now", value: 0 };
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { unit: "days", value: days };
  return { unit: "weeks", value: Math.floor(days / 7) };
}
