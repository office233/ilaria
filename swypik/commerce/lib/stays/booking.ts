/**
 * Rezervări Stays — ofertă (quote) și cererea de rezervare.
 *
 * Flux (vezi migrarea 20260926_0050):
 *   1. createBookingRequest → stay_bookings 'pending' cu expires_at (hold scurt)
 *   2. plata: card (hold Stripe, lib/stays/payment.ts) sau wallet → 'requested'
 *   3. gazda acceptă (capture + credit gazdă) / refuză (hold eliberat) —
 *      lib/stays/host-decisions.ts
 *   4. cron: pending/requested expirate → 'expired'; după check-out → 'completed'
 *
 * Constraint-ul EXCLUDE din DB rămâne sursa de adevăr contra dublei rezervări;
 * verificările de aici doar dau un motiv clar înainte de INSERT.
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { logger } from "@/lib/logger";
import { staysConfig } from "./config";
import { nightsBetween, nightsCount, todayIso, validateStayRange } from "./dates";
import { StaysError, type StaysErrorCode } from "./errors";
import { perNightCents, stayTotalCents } from "./policy";
import { BLOCKING_BOOKING_SQL, STAY_LISTING_SQL } from "./sql";

export type Q = <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>;
const db: Q = (text, params) => dbQuery(text, params ?? []);

export type StayListing = {
    id: string;
    title: string;
    status: string;
    currency: string | null;
    price_cents: number | null;
    vertical_attributes: Record<string, unknown> | null;
    max_guests: number | null;
    host_user_id: string;
};

export async function loadListing(q: Q, productId: string): Promise<StayListing | null> {
    const { rows } = await q<StayListing>(
        `SELECT p.id::text, p.title, p.status, p.currency, p.price_cents, p.vertical_attributes,
                (p.metadata->>'max_guests')::int AS max_guests,
                p.metadata->>'host_user_id' AS host_user_id
           FROM marketplace_products p
          WHERE p.id = $1::uuid AND ${STAY_LISTING_SQL}`,
        [productId],
    );
    return rows[0] ?? null;
}

/** Motivul pentru care intervalul nu e liber, sau null dacă e liber. */
export async function unavailableReason(
    q: Q,
    productId: string,
    checkIn: string,
    checkOut: string,
): Promise<"dates_blocked" | "dates_booked" | null> {
    const blocked = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM stay_availability
          WHERE product_id = $1::uuid AND is_available = false
            AND day >= $2::date AND day < $3::date`,
        [productId, checkIn, checkOut],
    );
    if (Number(blocked.rows[0]?.n ?? 0) > 0) return "dates_blocked";
    const booked = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM stay_bookings b
          WHERE b.product_id = $1::uuid AND ${BLOCKING_BOOKING_SQL}
            AND daterange(b.check_in, b.check_out) && daterange($2::date, $3::date)`,
        [productId, checkIn, checkOut],
    );
    return Number(booked.rows[0]?.n ?? 0) > 0 ? "dates_booked" : null;
}

/** Totalul cu prețurile speciale pe zi (sezon) setate de gazdă. */
export async function priceNights(q: Q, productId: string, nights: string[], baseCents: number): Promise<number> {
    const { rows } = await q<{ day: string; price_cents_override: number }>(
        `SELECT day::text AS day, price_cents_override FROM stay_availability
          WHERE product_id = $1::uuid AND day = ANY($2::date[]) AND price_cents_override IS NOT NULL`,
        [productId, nights],
    );
    return stayTotalCents(nights, baseCents, new Map(rows.map((r) => [r.day, Number(r.price_cents_override)])));
}

export type Quote = {
    productId: string;
    title: string;
    nights: number;
    pricePerNightCents: number;
    totalCents: number;
    currency: string;
    maxGuests: number;
    hostUserId: string;
    available: boolean;
    reason: StaysErrorCode | null;
};

function listingProblem(l: StayListing, guests: number, maxGuests: number): StaysErrorCode | null {
    if (l.status !== "active") return "not_published";
    if (perNightCents(l) <= 0) return "no_price";
    if (guests < 1 || guests > maxGuests) return "too_many_guests";
    return null;
}

/** Preț + disponibilitate (fără efecte). Aruncă not_found pentru listări inexistente. */
export async function quoteStay(
    productId: string,
    checkIn: string,
    checkOut: string,
    guests: number,
    now: Date = new Date(),
): Promise<Quote> {
    const l = await loadListing(db, productId);
    if (!l) throw new StaysError("not_found");
    const maxGuests = l.max_guests ?? staysConfig.maxGuests();
    const base = perNightCents(l);
    const nights = Math.max(0, nightsCount(checkIn, checkOut));
    const quote: Quote = {
        productId: l.id,
        title: l.title,
        nights,
        pricePerNightCents: base,
        totalCents: base * nights,
        currency: l.currency ?? "RON",
        maxGuests,
        hostUserId: l.host_user_id,
        available: false,
        reason: null,
    };
    const rangeErr = validateStayRange(checkIn, checkOut, { today: todayIso(now), maxNights: staysConfig.maxNights() });
    const problem = rangeErr ?? listingProblem(l, guests, maxGuests) ?? (await unavailableReason(db, productId, checkIn, checkOut));
    if (problem) return { ...quote, reason: problem };
    const totalCents = await priceNights(db, productId, nightsBetween(checkIn, checkOut), base);
    return { ...quote, totalCents, available: true };
}

export type BookingRequestInput = {
    productId: string;
    userId: string;
    guestName: string;
    guestEmail: string | null;
    guestPhone: string | null;
    checkIn: string;
    checkOut: string;
    guests: number;
};

export type CreatedBooking = { bookingId: string; totalCents: number; currency: string; expiresAt: string };

/**
 * Creează rezervarea 'pending' (hold scurt până la plată). În aceeași
 * tranzacție expiră hold-urile neplătite vechi ale listării, ca un 'pending'
 * abandonat să nu blocheze calendarul (audit: „calendar DoS”).
 */
export async function createBookingRequest(input: BookingRequestInput, now: Date = new Date()): Promise<CreatedBooking> {
    const rangeErr = validateStayRange(input.checkIn, input.checkOut, {
        today: todayIso(now),
        maxNights: staysConfig.maxNights(),
    });
    if (rangeErr) throw new StaysError(rangeErr);

    try {
        return await withTransaction(async (tq) => {
            const q: Q = (text, params) => tq(text, params ?? []);
            const l = await loadListing(q, input.productId);
            if (!l) throw new StaysError("not_found");
            if (l.host_user_id === input.userId) throw new StaysError("own_listing");
            const maxGuests = l.max_guests ?? staysConfig.maxGuests();
            const problem = listingProblem(l, input.guests, maxGuests);
            if (problem) throw new StaysError(problem);

            await q(
                `UPDATE stay_bookings SET status = 'expired', updated_at = now()
                  WHERE product_id = $1::uuid AND status = 'pending' AND expires_at <= now()`,
                [input.productId],
            );
            const reason = await unavailableReason(q, input.productId, input.checkIn, input.checkOut);
            if (reason) throw new StaysError(reason);

            const total = await priceNights(q, input.productId, nightsBetween(input.checkIn, input.checkOut), perNightCents(l));
            const { rows } = await q<{ id: string; expires_at: string }>(
                `INSERT INTO stay_bookings
                    (product_id, guest_user_id, host_user_id, guest_name, guest_email, guest_phone,
                     check_in, check_out, guests_count, total_cents, currency, status, payment_status,
                     expires_at)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date, $9, $10, $11,
                         'pending', 'pending', now() + ($12::int * interval '1 minute'))
                 RETURNING id::text, expires_at::text`,
                [
                    input.productId, input.userId, l.host_user_id, input.guestName, input.guestEmail,
                    input.guestPhone, input.checkIn, input.checkOut, input.guests, total,
                    l.currency ?? "RON", staysConfig.pendingPaymentTtlMin(),
                ],
            );
            logger.info({ bookingId: rows[0].id, productId: input.productId }, "stays: booking pending");
            return { bookingId: rows[0].id, totalCents: total, currency: l.currency ?? "RON", expiresAt: rows[0].expires_at };
        });
    } catch (err) {
        // Exclusion constraint: altcineva a rezervat intervalul între verificare și INSERT.
        if ((err as { code?: string })?.code === "23P01") throw new StaysError("dates_booked");
        throw err;
    }
}
