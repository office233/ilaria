/**
 * Duffel Stays — client (https://duffel.com/docs/api/stays).
 *
 * Necesită acces la produsul Stays pe contul Duffel (separat de Flights).
 * Fără acces, API-ul răspunde 403 — `isConfigured()` rămâne true dacă avem
 * cheie, dar apelurile întorc eroare clară, iar UI-ul afișează mesaj prietenos.
 *
 * Marja: 10% peste costul convertit în RON (aceleași reguli ca la Fly).
 */
import { logger } from "@/lib/logger";
import { toRonCents } from "@/lib/fly/fx";
import { computeMarkupRonCents } from "@/lib/fly/types";
import {
    CreateStayBookingInput,
    CreateStayBookingResult,
    StayQuote,
    StayResult,
    StaySearchParams,
} from "./types";

const BASE = () => process.env.DUFFEL_API_URL || "https://api.duffel.com";

export class StaysAccessError extends Error {
    constructor() {
        super("Duffel Stays nu este activat pe acest cont");
        this.name = "StaysAccessError";
    }
}

async function duffelFetch<T>(
    path: string,
    init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; errors?: any[] }> {
    const key = process.env.DUFFEL_API_KEY;
    if (!key) return { ok: false, status: 401, errors: [{ message: "DUFFEL_API_KEY lipsă" }] };

    let r: Response;
    try {
        r = await fetch(`${BASE()}${path}`, {
            method: init?.method ?? "GET",
            headers: {
                Authorization: `Bearer ${key}`,
                "Duffel-Version": "v2",
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: init?.body ? JSON.stringify({ data: init.body }) : undefined,
            signal: AbortSignal.timeout(25000),
        });
    } catch (err) {
        // Fără acest catch, un abort de timeout urca necontextualizat până la
        // handler-ul de erori — "[Error [TimeoutError]: ...]" fără nicio urmă
        // că sursa era Duffel.
        logger.warn({ err, path }, "[duffel] fetch failed or timed out");
        return { ok: false, status: 599, errors: [{ message: "duffel_unreachable" }] };
    }

    if (r.status === 403) throw new StaysAccessError();

    const json = (await r.json().catch(() => ({}))) as any;
    return { ok: r.ok, status: r.status, data: json.data as T, errors: json.errors };
}

function nightsBetween(a: string, b: string): number {
    return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

function toCents(amount: string | number): number {
    return Math.round(Number(amount) * 100);
}

export function isStaysConfigured(): boolean {
    return Boolean(process.env.DUFFEL_API_KEY);
}

export async function searchStays(params: StaySearchParams): Promise<StayResult[]> {
    const guests = Array.from({ length: params.adults }, () => ({ type: "adult" }));
    const r = await duffelFetch<any>("/stays/search", {
        method: "POST",
        body: {
            location: {
                radius: params.radiusKm ?? 8,
                geographic_coordinates: { latitude: params.lat, longitude: params.lng },
            },
            check_in_date: params.checkIn,
            check_out_date: params.checkOut,
            guests,
            rooms: params.rooms ?? 1,
        },
    });

    if (!r.ok || !r.data) {
        logger.warn({ status: r.status, errors: r.errors }, "stays: search failed");
        return [];
    }

    const nights = nightsBetween(params.checkIn, params.checkOut);
    const results: any[] = r.data.results ?? [];

    return Promise.all(
        results.map(async (res) => {
            const providerCurrency = res.cheapest_rate_currency ?? "EUR";
            const providerTotalCents = toCents(res.cheapest_rate_total_amount ?? 0);
            const ronCost = await toRonCents(providerTotalCents, providerCurrency);
            const markup = computeMarkupRonCents(ronCost);
            const acc = res.accommodation ?? {};
            return {
                provider: "duffel" as const,
                searchResultId: res.id,
                accommodationId: acc.id ?? "",
                name: acc.name ?? "Cazare",
                stars: acc.rating ?? null,
                photoUrl: acc.photos?.[0]?.url ?? null,
                address: acc.location?.address?.line_one ?? null,
                lat: acc.location?.geographic_coordinates?.latitude ?? null,
                lng: acc.location?.geographic_coordinates?.longitude ?? null,
                providerTotalCents,
                providerCurrency,
                totalCents: ronCost + markup,
                markupCents: markup,
                currency: "RON" as const,
                nights,
                checkIn: params.checkIn,
                checkOut: params.checkOut,
            };
        }),
    );
}

/** Ratele disponibile pentru un rezultat + quote (preț garantat înainte de plată). */
export async function fetchRates(searchResultId: string): Promise<any[]> {
    const r = await duffelFetch<any>(`/stays/search_results/${encodeURIComponent(searchResultId)}/actions/fetch_all_rates`, {
        method: "POST",
        body: {},
    });
    if (!r.ok || !r.data) {
        logger.warn({ status: r.status, errors: r.errors }, "stays: fetch rates failed");
        return [];
    }
    return r.data.rooms ?? [];
}

/** Quote — preț garantat pentru o rată aleasă (obligatoriu înainte de booking). */
export async function createQuote(rateId: string): Promise<StayQuote | null> {
    const r = await duffelFetch<any>("/stays/quotes", { method: "POST", body: { rate_id: rateId } });
    if (!r.ok || !r.data) {
        logger.warn({ status: r.status, errors: r.errors }, "stays: quote failed");
        return null;
    }
    const q = r.data;
    const providerCurrency = q.total_currency ?? "EUR";
    const providerTotalCents = toCents(q.total_amount ?? 0);
    const ronCost = await toRonCents(providerTotalCents, providerCurrency);
    const markup = computeMarkupRonCents(ronCost);
    return {
        quoteId: q.id,
        accommodationName: q.accommodation?.name ?? "Cazare",
        roomName: q.room_rate?.room_name ?? null,
        boardType: q.room_rate?.board_type ?? null,
        cancellationDeadline: q.room_rate?.cancellation_timeline?.[0]?.before ?? null,
        providerTotalCents,
        providerCurrency,
        totalCents: ronCost + markup,
        markupCents: markup,
        currency: "RON",
        checkIn: q.check_in_date,
        checkOut: q.check_out_date,
    };
}

export async function createStayBooking(
    input: CreateStayBookingInput,
): Promise<CreateStayBookingResult> {
    const r = await duffelFetch<any>("/stays/bookings", {
        method: "POST",
        body: {
            quote_id: input.quoteId,
            guests: input.guests.map((g) => ({ given_name: g.givenName, family_name: g.familyName })),
            email: input.email,
            phone_number: input.phone,
            accommodation_special_requests: null,
        },
    });
    if (!r.ok || !r.data) {
        return { ok: false, error: r.errors?.[0]?.message ?? "rezervare eșuată" };
    }
    return {
        ok: true,
        bookingId: r.data.id,
        confirmationCode: r.data.reference ?? null,
    };
}
