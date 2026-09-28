/**
 * Kiwi Tequila provider — https://tequila.kiwi.com/portal/docs
 * Env: KIWI_TEQUILA_API_KEY. Dacă lipsește, providerul e inactiv (isConfigured=false).
 *
 * Search: /v2/search. Price check: /v2/booking/check_flights (booking_token).
 * Booking-ul complet Kiwi (save_booking + confirm_payment) cere cont de
 * booking aprobat — până atunci createOrder returnează mesaj explicit.
 */
import { logger } from "@/lib/logger";
import {
    CreateOrderInput,
    CreateOrderResult,
    FlightOffer,
    FlightProvider,
    FlightSearchParams,
    PriceCheckResult,
    computeMarkupRonCents,
    toCents,
} from "./types";

const BASE = "https://api.tequila.kiwi.com";

function toKiwiDate(iso: string): string {
    // YYYY-MM-DD -> DD/MM/YYYY
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

function mapItinerary(it: any, currency: string): FlightOffer {
    const providerTotalCents = toCents(it.price);
    // NOTĂ: Kiwi e inactiv (fără chei). La reactivare, prețul trebuie trecut
    // prin FX→RON ca la Duffel; până atunci aplicăm procentul direct.
    const markup = computeMarkupRonCents(providerTotalCents);
    const outbound = (it.route ?? []).filter((r: any) => r.return === 0);
    const inbound = (it.route ?? []).filter((r: any) => r.return === 1);
    const toSlice = (legs: any[]) =>
        legs.length
            ? {
                origin: legs[0].flyFrom,
                destination: legs[legs.length - 1].flyTo,
                durationMinutes: Math.round(
                    (new Date(legs[legs.length - 1].utc_arrival).getTime() -
                        new Date(legs[0].utc_departure).getTime()) / 60000,
                ),
                segments: legs.map((l: any) => ({
                    origin: l.flyFrom,
                    destination: l.flyTo,
                    departAt: l.local_departure,
                    arriveAt: l.local_arrival,
                    carrier: l.airline,
                    flightNumber: String(l.flight_no ?? ""),
                    durationMinutes: Math.round(
                        (new Date(l.utc_arrival).getTime() - new Date(l.utc_departure).getTime()) / 60000,
                    ),
                })),
            }
            : null;
    const slices = [toSlice(outbound), toSlice(inbound)].filter(Boolean) as FlightOffer["slices"];
    return {
        provider: "kiwi",
        offerId: it.booking_token,
        providerTotalCents,
        providerCurrency: currency,
        markupCents: markup,
        totalCents: providerTotalCents + markup,
        currency,
        slices,
        stops: Math.max(0, ...slices.map((s) => s.segments.length - 1)),
        carrier: it.airlines?.[0] ?? "",
        baggageIncluded: false,
        expiresAt: null,
        raw: {},
    };
}

export const kiwiProvider: FlightProvider = {
    id: "kiwi",

    isConfigured() {
        return Boolean(process.env.KIWI_TEQUILA_API_KEY);
    },

    async search(params: FlightSearchParams): Promise<FlightOffer[]> {
        const currency = params.currency ?? "EUR";
        const q = new URLSearchParams({
            fly_from: params.origin,
            fly_to: params.destination,
            date_from: toKiwiDate(params.departDate),
            date_to: toKiwiDate(params.departDate),
            adults: String(params.adults),
            children: String(params.children ?? 0),
            infants: String(params.infants ?? 0),
            curr: currency,
            limit: String(params.maxResults ?? 30),
            sort: "price",
            max_stopovers: "2",
        });
        if (params.returnDate) {
            q.set("return_from", toKiwiDate(params.returnDate));
            q.set("return_to", toKiwiDate(params.returnDate));
            q.set("flight_type", "round");
        } else {
            q.set("flight_type", "oneway");
        }
        const res = await fetch(`${BASE}/v2/search?${q}`, {
            headers: { apikey: process.env.KIWI_TEQUILA_API_KEY!, Accept: "application/json" },
            cache: "no-store",
        });
        if (!res.ok) {
            logger.warn({ status: res.status }, "kiwi search failed");
            return [];
        }
        const json = await res.json().catch(() => ({}));
        return ((json?.data as any[]) ?? []).map((it) => mapItinerary(it, currency));
    },

    async priceCheck(offer: FlightOffer): Promise<PriceCheckResult> {
        const q = new URLSearchParams({
            booking_token: offer.offerId,
            bnum: "0",
            adults: "1",
            currency: offer.currency,
        });
        const res = await fetch(`${BASE}/v2/booking/check_flights?${q}`, {
            headers: { apikey: process.env.KIWI_TEQUILA_API_KEY!, Accept: "application/json" },
            cache: "no-store",
        });
        if (!res.ok) return { ok: false, reason: "provider_error" };
        const json = await res.json().catch(() => ({} as any));
        if (json.flights_invalid) return { ok: false, reason: "unavailable" };
        const freshTotal = toCents(json.conversion?.amount ?? json.total ?? 0) + offer.markupCents;
        const delta = freshTotal - offer.totalCents;
        return {
            ok: true,
            offer: { ...offer, providerTotalCents: freshTotal - offer.markupCents, totalCents: freshTotal },
            deltaCents: delta,
            reason: json.price_change || delta !== 0 ? "price_changed" : undefined,
        };
    },

    async createOrder(_input: CreateOrderInput): Promise<CreateOrderResult> {
        // Booking API Kiwi cere cont de booking aprobat (Zooz payments).
        // Până la aprobare, ofertele Kiwi nu sunt rezervabile — clientul rămâne
        // pe Swypik și alege o ofertă Duffel (emitere instant la noi).
        return {
            ok: false,
            message: "Această ofertă nu e rezervabilă momentan — alege o ofertă cu emitere instant.",
        };
    },
};
