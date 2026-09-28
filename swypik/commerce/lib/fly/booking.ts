/**
 * Swypik Fly — booking service.
 *
 * Flux comun (wallet sau Stripe):
 *   1. priceCheck live (revalidare preț la furnizor) — obligatoriu;
 *   2. INSERT flight_bookings (pending) cu snapshot-ul ofertei revalidate;
 *   3a. wallet: debitUser (idempotent pe ref) → ticketing la furnizor;
 *   3b. stripe: Checkout Session cu metadata.fly_booking_id → webhook-ul
 *       apelează fulfillFlightBooking() după plată;
 *   4. ticketing OK → status 'ticketed' + push cross-sell (Eats înainte de zbor).
 *
 * Dacă ticketing-ul eșuează DUPĂ încasare: wallet → refund automat în ledger;
 * stripe → status 'failed' + alertă ops (refund manual/API).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { creditUser, debitUser, InsufficientFundsError } from "@/lib/wallet/ledger";
import { sendPushToUser } from "@/lib/push/send";
import { createOrder, getCachedOffer, priceCheck } from "./service";
import { FlightOffer, PassengerInput } from "./types";

export type BookingRow = {
    id: string;
    user_id: string;
    provider: string;
    status: string;
    origin: string;
    destination: string;
    depart_date: string;
    return_date: string | null;
    total_cents: number;
    currency: string;
    booking_ref: string | null;
    payment_method: string | null;
    created_at: string;
};

export type StartBookingInput = {
    userId: string;
    offerToken: string;
    passengers: PassengerInput[];
    contactEmail: string;
    contactPhone: string;
    paymentMethod: "wallet" | "stripe";
};

export type StartBookingResult =
    | { ok: true; bookingId: string; status: "ticketed"; bookingRef: string | null }
    | { ok: true; bookingId: string; status: "stripe_redirect"; checkoutUrl: string }
    | { ok: false; code: "price_changed"; bookingId?: string; newTotalCents: number; deltaCents: number; token: string }
    | { ok: false; code: "offer_expired" | "insufficient_funds" | "provider_error"; message?: string };

async function insertBooking(
    userId: string,
    offer: FlightOffer,
    passengers: PassengerInput[],
    paymentMethod: "wallet" | "stripe",
): Promise<string> {
    const firstSlice = offer.slices[0];
    const lastSlice = offer.slices.length > 1 ? offer.slices[offer.slices.length - 1] : null;
    const { rows } = await dbQuery<{ id: string }>(
        `INSERT INTO flight_bookings
       (user_id, provider, provider_offer_id, origin, destination, depart_date, return_date,
        passengers, offer_snapshot, provider_total_cents, markup_cents, total_cents, currency, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id::text`,
        [
            userId,
            offer.provider,
            offer.offerId,
            firstSlice?.origin ?? "",
            firstSlice?.destination ?? "",
            firstSlice?.segments[0]?.departAt?.slice(0, 10) ?? null,
            lastSlice?.segments[0]?.departAt?.slice(0, 10) ?? null,
            JSON.stringify(passengers),
            JSON.stringify(offer),
            offer.providerTotalCents,
            offer.markupCents,
            offer.totalCents,
            offer.currency,
            paymentMethod,
        ],
    );
    return rows[0].id;
}

async function setStatus(
    bookingId: string,
    status: string,
    patch: { bookingRef?: string; providerOrderId?: string; paymentRef?: string; errorMessage?: string } = {},
): Promise<void> {
    await dbQuery(
        `UPDATE flight_bookings
        SET status = $2,
            booking_ref = COALESCE($3, booking_ref),
            provider_order_id = COALESCE($4, provider_order_id),
            payment_ref = COALESCE($5, payment_ref),
            error_message = COALESCE($6, error_message),
            updated_at = now()
      WHERE id = $1`,
        [bookingId, status, patch.bookingRef ?? null, patch.providerOrderId ?? null, patch.paymentRef ?? null, patch.errorMessage ?? null],
    );
}

/** Ticketing la furnizor + push cross-sell. Folosit de wallet flow și de webhook Stripe. */
export async function ticketBooking(bookingId: string): Promise<{ ok: boolean; bookingRef?: string; message?: string }> {
    const { rows } = await dbQuery<any>(
        `SELECT id::text, user_id, status, passengers, offer_snapshot, origin, destination, depart_date::text
       FROM flight_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
    );
    const b = rows[0];
    if (!b) return { ok: false, message: "booking not found" };
    if (b.status === "ticketed") return { ok: true, bookingRef: undefined }; // idempotent

    const offer = b.offer_snapshot as FlightOffer;
    const passengers = b.passengers as PassengerInput[];
    const contactEmail = passengers[0]?.email ?? "";
    const contactPhone = passengers[0]?.phone ?? "";

    const result = await createOrder({ offer, passengers, contactEmail, contactPhone });
    if (!result.ok) {
        await setStatus(bookingId, "failed", { errorMessage: result.message });
        return { ok: false, message: result.message };
    }

    await setStatus(bookingId, "ticketed", {
        bookingRef: result.bookingRef,
        providerOrderId: result.providerOrderId,
    });

    // Cross-sell Super-App: mâncare în drum spre aeroport.
    sendPushToUser(b.user_id, {
        title: `Zbor confirmat ${b.origin} → ${b.destination} ✈️`,
        body: "Comandă mâncare prin Swypik în drum spre aeroport și ai reducere 10%.",
        url: "/explore",
        tag: `fly-${bookingId}`,
    }).catch((err) => logger.warn({ err }, "fly: cross-sell push failed"));

    return { ok: true, bookingRef: result.bookingRef };
}

export async function startBooking(input: StartBookingInput): Promise<StartBookingResult> {
    // 1. Live price check — nu plătim niciodată pe preț de cache.
    const check = await priceCheck(input.offerToken);
    if (!check.ok || !check.offer) {
        return { ok: false, code: "offer_expired", message: check.message };
    }
    const offer = check.offer;
    if ((check.deltaCents ?? 0) !== 0) {
        // Preț schimbat: nu blocăm, dar clientul trebuie să reconfirme noul total.
        return {
            ok: false,
            code: "price_changed",
            newTotalCents: offer.totalCents,
            deltaCents: check.deltaCents ?? 0,
            token: input.offerToken,
        };
    }

    const bookingId = await insertBooking(input.userId, offer, input.passengers, input.paymentMethod);

    if (input.paymentMethod === "wallet") {
        try {
            const debit = await debitUser({
                userId: input.userId,
                amountCents: offer.totalCents,
                refType: "flight_booking",
                refId: bookingId,
                description: `Bilet avion ${offer.slices[0]?.origin} → ${offer.slices[0]?.destination}`,
            });
            await setStatus(bookingId, "paid", { paymentRef: debit.entry?.id });
        } catch (err) {
            if (err instanceof InsufficientFundsError) {
                await setStatus(bookingId, "cancelled", { errorMessage: "insufficient funds" });
                return { ok: false, code: "insufficient_funds" };
            }
            throw err;
        }

        const ticket = await ticketBooking(bookingId);
        if (!ticket.ok) {
            // Refund automat în wallet — idempotent pe (flight_refund, bookingId).
            await creditUser({
                userId: input.userId,
                amountCents: offer.totalCents,
                refType: "flight_refund",
                refId: bookingId,
                description: "Refund bilet avion — emitere eșuată",
            });
            return { ok: false, code: "provider_error", message: ticket.message };
        }
        return { ok: true, bookingId, status: "ticketed", bookingRef: ticket.bookingRef ?? null };
    }

    // Stripe: Checkout Session dedicată, fulfill în webhook via metadata.
    const { createFlightCheckoutSession } = await import("./stripe");
    const session = await createFlightCheckoutSession(bookingId, offer, input.contactEmail);
    await setStatus(bookingId, "pending", { paymentRef: session.sessionId });
    return { ok: true, bookingId, status: "stripe_redirect", checkoutUrl: session.url };
}

/** Apelat din webhook-ul Stripe la checkout.session.completed. */
export async function fulfillFlightBooking(bookingId: string): Promise<void> {
    await setStatus(bookingId, "paid");
    const ticket = await ticketBooking(bookingId);
    if (!ticket.ok) {
        logger.error({ bookingId, message: ticket.message }, "fly: ticketing failed AFTER stripe payment — refund necesar");
    }
}

export async function listUserBookings(userId: string): Promise<BookingRow[]> {
    const { rows } = await dbQuery<BookingRow>(
        `SELECT id::text, user_id, provider, status, origin, destination,
            depart_date::text, return_date::text, total_cents::int8 AS total_cents,
            currency, booking_ref, payment_method, created_at::text
       FROM flight_bookings
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
        [userId],
    );
    return rows;
}

export { getCachedOffer };
