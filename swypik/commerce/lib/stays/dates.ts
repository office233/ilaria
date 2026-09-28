/**
 * Utilitare de date pentru Stays — pure, în UTC, pe șiruri YYYY-MM-DD.
 * Intervalele sunt semi-deschise: [checkIn, checkOut) = nopțile dormite.
 */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(s: unknown): s is string {
    if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
    return toIsoDate(now);
}

export function addDays(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return toIsoDate(d);
}

/** Numărul de nopți dintre două date (poate fi ≤ 0 pentru intervale invalide). */
export function nightsCount(checkIn: string, checkOut: string): number {
    return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}

/** Lista nopților [checkIn, checkOut). */
export function nightsBetween(checkIn: string, checkOut: string): string[] {
    const out: string[] = [];
    const n = nightsCount(checkIn, checkOut);
    for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
    return out;
}

/** Două intervale semi-deschise se suprapun? (check-out = check-in al altuia NU e suprapunere). */
export function rangesOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
    return aIn < bOut && bIn < aOut;
}

export type RangeError = "invalid_dates" | "past_dates" | "too_long";

/** Validează un interval de rezervare; null = ok. */
export function validateStayRange(
    checkIn: string,
    checkOut: string,
    opts: { today: string; maxNights: number },
): RangeError | null {
    if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return "invalid_dates";
    const n = nightsCount(checkIn, checkOut);
    if (n < 1) return "invalid_dates";
    if (checkIn < opts.today) return "past_dates";
    if (n > opts.maxNights) return "too_long";
    return null;
}

/** Zilele (nopțile) ocupate de o listă de intervale, ca set pentru calendar. */
export function occupiedNights(ranges: { check_in: string; check_out: string }[]): Set<string> {
    const s = new Set<string>();
    for (const r of ranges) for (const n of nightsBetween(r.check_in, r.check_out)) s.add(n);
    return s;
}

/** Zile întregi rămase până la check-in (negativ după). */
export function daysUntil(checkIn: string, now: Date): number {
    return Math.floor((Date.parse(`${checkIn}T00:00:00Z`) - now.getTime()) / DAY_MS);
}
