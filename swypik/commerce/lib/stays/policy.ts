/**
 * Reguli de bani și de stare pentru Stays — funcții pure, testate unitar.
 * O SINGURĂ sursă pentru preț/noapte, total, comision și refund.
 */
import { daysUntil } from "./dates";

type PriceRow = { price_cents?: number | null; vertical_attributes?: Record<string, unknown> | null };

/**
 * Prețul pe noapte în bani. `price_cents` e canonic (migrarea 0051 l-a
 * completat pentru listările vechi); `vertical_attributes.price_per_night`
 * (LEI) rămâne doar ca plasă de siguranță.
 */
export function perNightCents(row: PriceRow): number {
    const cents = Number(row.price_cents);
    if (Number.isFinite(cents) && cents > 0) return Math.round(cents);
    const lei = Number(row.vertical_attributes?.price_per_night);
    return Number.isFinite(lei) && lei > 0 ? Math.round(lei * 100) : 0;
}

/** Totalul pentru nopțile date, cu prețuri speciale pe zi unde există. */
export function stayTotalCents(nights: string[], baseCents: number, overrides: Map<string, number>): number {
    return nights.reduce((sum, n) => sum + (overrides.get(n) ?? baseCents), 0);
}

/** Împărțirea totalului: comisionul Swypik și netul gazdei. */
export function splitCommission(totalCents: number, pct: number): { commissionCents: number; hostNetCents: number } {
    const commissionCents = Math.round((totalCents * pct) / 100);
    return { commissionCents, hostNetCents: totalCents - commissionCents };
}

export type RefundDecision = { refundPct: number; refundCents: number };

/**
 * Refundul la anulare:
 *  - gazda anulează → 100%
 *  - clientul, cu ≥ freeDays zile înainte → 100%
 *  - clientul, mai târziu → latePct%
 */
export function refundFor(input: {
    totalCents: number;
    checkIn: string;
    now: Date;
    by: "guest" | "host";
    freeDays: number;
    latePct: number;
}): RefundDecision {
    const pct =
        input.by === "host" || daysUntil(input.checkIn, input.now) >= input.freeDays ? 100 : input.latePct;
    return { refundPct: pct, refundCents: Math.round((input.totalCents * pct) / 100) };
}

/**
 * Cât i se retrage gazdei după un refund: gazda a primit netul; păstrează doar
 * partea proporțională cu ce a rămas reținut de la client.
 */
export function hostClawbackCents(totalCents: number, refundCents: number, pct: number): number {
    if (totalCents <= 0 || refundCents <= 0) return 0;
    const { hostNetCents } = splitCommission(totalCents, pct);
    const hostKeeps = Math.round((hostNetCents * (totalCents - refundCents)) / totalCents);
    return Math.max(0, hostNetCents - hostKeeps);
}

export type BookingStatus =
    | "pending"
    | "requested"
    | "confirmed"
    | "completed"
    | "declined"
    | "expired"
    | "cancelled";

/** Ține o rezervare intervalul ocupat acum? (pending doar până la termen). */
export function isBlocking(status: string, expiresAt: string | Date | null, now: Date): boolean {
    if (status === "requested" || status === "confirmed") return true;
    if (status !== "pending") return false;
    if (!expiresAt) return true;
    return new Date(expiresAt).getTime() > now.getTime();
}

/** Stări din care clientul poate anula. */
export function guestCanCancel(status: string, checkIn: string, today: string): boolean {
    return ["pending", "requested", "confirmed"].includes(status) && checkIn > today;
}

/** Recenzia e permisă după check-out, în fereastra configurată. */
export function canReview(input: { status: string; checkOut: string; today: string; windowDays: number }): boolean {
    if (input.status !== "completed" && input.status !== "confirmed") return false;
    if (input.checkOut > input.today) return false;
    const days = Math.round((Date.parse(`${input.today}T00:00:00Z`) - Date.parse(`${input.checkOut}T00:00:00Z`)) / 86_400_000);
    return days <= input.windowDays;
}
