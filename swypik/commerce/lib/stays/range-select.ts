/**
 * Logica de selecție a intervalului în calendar (pură, testată). Un interval
 * [checkIn, checkOut) e valid doar dacă niciuna dintre NOPȚI nu e ocupată;
 * ziua de check-out poate fi ocupată (altcineva face check-in atunci).
 */
import { nightsBetween } from "./dates";

export type Range = { checkIn: string | null; checkOut: string | null };

export function rangeIsFree(checkIn: string, checkOut: string, occupied: ReadonlySet<string>): boolean {
    return nightsBetween(checkIn, checkOut).every((n) => !occupied.has(n));
}

/** Noua selecție după o apăsare pe `day`. */
export function nextRange(current: Range, day: string, occupied: ReadonlySet<string>, maxNights: number): Range {
    const { checkIn, checkOut } = current;
    const startFresh: Range = occupied.has(day) ? { checkIn: null, checkOut: null } : { checkIn: day, checkOut: null };
    if (!checkIn || checkOut) return startFresh;
    if (day <= checkIn) return startFresh;
    if (nightsBetween(checkIn, day).length > maxNights) return startFresh;
    return rangeIsFree(checkIn, day, occupied) ? { checkIn, checkOut: day } : startFresh;
}

/** Se poate apăsa ziua? (trecutul nu; nopțile ocupate doar ca check-out valid) */
export function isSelectable(current: Range, day: string, minDate: string, occupied: ReadonlySet<string>, maxNights: number): boolean {
    if (day < minDate) return false;
    if (!occupied.has(day)) return true;
    const choosingCheckout = Boolean(current.checkIn && !current.checkOut);
    if (!choosingCheckout || day <= current.checkIn!) return false;
    return nightsBetween(current.checkIn!, day).length <= maxNights && rangeIsFree(current.checkIn!, day, occupied);
}

/** Zilele unei luni (YYYY-MM-DD), precedate de `offset` celule goale (săptămâna începe luni). */
export function monthGrid(year: number, month0: number): { offset: number; days: string[] } {
    const first = new Date(Date.UTC(year, month0, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    const days: string[] = [];
    for (let d = 1; d <= count; d++) days.push(new Date(Date.UTC(year, month0, d)).toISOString().slice(0, 10));
    return { offset, days };
}
