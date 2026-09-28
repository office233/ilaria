/**
 * Swypik Stays — configurare unică (env cu valori implicite sigure).
 * Nicio limită/durată/procent nu se mai hardcodează în rute sau UI.
 */
import { STAYS_COMMISSION_BPS } from "@/lib/config/commerce";

function intEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : fallback;
}

/** Comisionul Swypik (%) reținut din total; gazda primește restul. */
export function commissionPct(): number {
    const fallback = STAYS_COMMISSION_BPS / 100;
    const raw = process.env.STAYS_COMMISSION_PCT;
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 50 ? v : fallback;
}

/** Anulare gratuită (refund 100%) cu cel puțin N zile înainte de check-in. */
export function freeCancelDays(): number {
    return intEnv("STAYS_FREE_CANCEL_DAYS", 5, 0, 60);
}

/** Refund (%) sub pragul de anulare gratuită. */
export function lateCancelRefundPct(): number {
    return intEnv("STAYS_LATE_CANCEL_REFUND_PCT", 50, 0, 100);
}

export const staysConfig = {
    /** Cât ține un hold neplătit (pending) înainte să elibereze calendarul. */
    pendingPaymentTtlMin: () => intEnv("STAYS_PENDING_TTL_MIN", 15, 5, 120),
    /** Cât are gazda să accepte o cerere plătită (hold card ≤ 7 zile la Stripe). */
    hostResponseTtlHours: () => intEnv("STAYS_HOST_RESPONSE_TTL_HOURS", 24, 1, 144),
    /** Câte zile după check-out se mai poate lăsa o recenzie. */
    reviewWindowDays: () => intEnv("STAYS_REVIEW_WINDOW_DAYS", 30, 1, 365),
    maxNights: () => intEnv("STAYS_MAX_NIGHTS", 60, 1, 365),
    maxGuests: () => intEnv("STAYS_MAX_GUESTS", 16, 1, 50),
    minPricePerNightCents: () => intEnv("STAYS_MIN_PRICE_CENTS", 2000, 100, 100000),
    maxPricePerNightCents: () => intEnv("STAYS_MAX_PRICE_CENTS", 10_000_000, 1000, 100_000_000),
    maxPhotos: () => intEnv("STAYS_MAX_PHOTOS", 10, 1, 30),
    /** Stripe cere minim ~2 RON pe o plată cu cardul. */
    minCardAmountCents: () => intEnv("STAYS_MIN_CARD_CENTS", 200, 50, 10000),
    searchLimit: () => intEnv("STAYS_SEARCH_LIMIT", 30, 5, 100),
} as const;

/** Facilități acceptate pe o listare (cheile vin din registrul verticalei). */
export const STAY_AMENITIES = ["wifi", "kitchen", "parking", "pool", "pets_allowed", "air_conditioning", "washer"] as const;
export type StayAmenity = (typeof STAY_AMENITIES)[number];

/** Tipuri de proprietate (aceleași ca în aplicația de gazdă). */
export const STAY_PROPERTY_TYPES = ["apartament", "casa", "vila", "cabana", "pensiune", "hotel"] as const;
