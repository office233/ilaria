/**
 * Coduri de eroare stabile pentru API-ul Stays. Clientul le traduce prin
 * `staysUi.errors.<code>` — serverul nu mai trimite text românesc.
 */
import { NextResponse } from "next/server";

export const STAYS_ERROR_CODES = [
    "unauthorized",
    "rate_limited",
    "invalid_input",
    "not_found",
    "forbidden",
    "invalid_dates",
    "past_dates",
    "too_long",
    "not_published",
    "no_price",
    "too_many_guests",
    "dates_blocked",
    "dates_booked",
    "own_listing",
    "bad_state",
    "insufficient_funds",
    "payment_failed",
    "payment_not_authorized",
    "amount_too_small",
    "card_unavailable",
    "not_host",
    "already_reviewed",
    "review_not_allowed",
    "photo_not_allowed",
    "publish_incomplete",
    "has_active_bookings",
    "legacy_retired",
    "internal_error",
] as const;

export type StaysErrorCode = (typeof STAYS_ERROR_CODES)[number];

const STATUS: Partial<Record<StaysErrorCode, number>> = {
    unauthorized: 401,
    rate_limited: 429,
    not_found: 404,
    forbidden: 403,
    not_host: 403,
    insufficient_funds: 402,
    dates_blocked: 409,
    dates_booked: 409,
    bad_state: 409,
    already_reviewed: 409,
    has_active_bookings: 409,
    legacy_retired: 410,
    payment_failed: 502,
    card_unavailable: 503,
    internal_error: 500,
};

/** Răspuns JSON `{ error: code }` cu statusul HTTP potrivit (implicit 400). */
export function staysError(code: StaysErrorCode, status?: number): NextResponse {
    return NextResponse.json({ error: code }, { status: status ?? STATUS[code] ?? 400 });
}

/** Eroare de domeniu aruncată din lib/stays, transformată în răspuns de rută. */
export class StaysError extends Error {
    constructor(public readonly code: StaysErrorCode) {
        super(code);
        this.name = "StaysError";
    }
}
