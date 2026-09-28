/**
 * Duffel provider — https://duffel.com/docs (API v2).
 * Env: DUFFEL_API_KEY, DUFFEL_API_URL (default https://api.duffel.com).
 *
 * Flux: offer_requests (search) → offers → orders (booking cu pasageri).
 * Prețuri: total_amount este string decimal → convertit în cenți.
 */
import { logger } from "@/lib/logger";
import { toRonCents, DISPLAY_CURRENCY } from "./fx";
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

const BASE = () => process.env.DUFFEL_API_URL || "https://api.duffel.com";

type DuffelApiError = { message?: string; [key: string]: unknown };

async function duffelFetch<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; errors?: DuffelApiError[] }> {
    let res: Response;
    try {
        res = await fetch(`${BASE()}${path}`, {
            method: init?.method ?? "GET",
            headers: {
                Authorization: `Bearer ${process.env.DUFFEL_API_KEY}`,
                "Duffel-Version": "v2",
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: init?.body ? JSON.stringify({ data: init.body }) : undefined,
            cache: "no-store",
        });
    } catch (err) {
        logger.warn({ err, path }, "[fly/duffel] fetch failed or timed out");
        return { ok: false, status: 599, errors: [{ message: "duffel_unreachable" }] };
    }
    const json = await res.json().catch(() => ({} as Record<string, unknown>));
    return { ok: res.ok, status: res.status, data: (json as Record<string, unknown>)?.data as T, errors: (json as Record<string, unknown>)?.errors as DuffelApiError[] };
}

function minutesBetween(a: string, b: string): number {
    return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

async function mapOffer(o: any): Promise<FlightOffer> {
    const providerTotalCents = toCents(o.total_amount);
    const providerCurrency = o.total_currency ?? "EUR";
    // Afișăm și încasăm totul în RON: cost furnizor convertit + marjă procentuală.
    const ronTotal = await toRonCents(providerTotalCents, providerCurrency);
    const ronMarkup = computeMarkupRonCents(ronTotal);
    const slices = (o.slices ?? []).map((s: any) => ({
        origin: s.origin?.iata_code ?? "",
        destination: s.destination?.iata_code ?? "",
        durationMinutes: s.segments?.length
            ? minutesBetween(s.segments[0].departing_at, s.segments[s.segments.length - 1].arriving_at)
            : undefined,
        segments: (s.segments ?? []).map((seg: any) => ({
            origin: seg.origin?.iata_code ?? "",
            destination: seg.destination?.iata_code ?? "",
            departAt: seg.departing_at,
            arriveAt: seg.arriving_at,
            carrier: seg.marketing_carrier?.iata_code ?? "",
            carrierName: seg.marketing_carrier?.name,
            flightNumber: seg.marketing_carrier_flight_number,
            durationMinutes: minutesBetween(seg.departing_at, seg.arriving_at),
        })),
    }));
    const stops = Math.max(0, ...slices.map((s: any) => s.segments.length - 1));
    return {
        provider: "duffel",
        offerId: o.id,
        providerTotalCents,
        providerCurrency,
        markupCents: ronMarkup,
        totalCents: ronTotal + ronMarkup,
        currency: DISPLAY_CURRENCY,
        slices,
        stops,
        carrier: o.owner?.iata_code ?? "",
        carrierName: o.owner?.name,
        baggageIncluded: Boolean(
            o.slices?.[0]?.segments?.[0]?.passengers?.[0]?.baggages?.some(
                (b: any) => b.type === "checked" && b.quantity > 0,
            ),
        ),
        expiresAt: o.expires_at ?? null,
        raw: { passengers: o.passengers?.map((p: any) => ({ id: p.id, type: p.type })) },
    };
}

export const duffelProvider: FlightProvider = {
    id: "duffel",

    isConfigured() {
        return Boolean(process.env.DUFFEL_API_KEY);
    },

    async search(params: FlightSearchParams): Promise<FlightOffer[]> {
        const passengers: any[] = [];
        for (let i = 0; i < params.adults; i++) passengers.push({ type: "adult" });
        for (let i = 0; i < (params.children ?? 0); i++) passengers.push({ type: "child" });
        for (let i = 0; i < (params.infants ?? 0); i++) passengers.push({ type: "infant_without_seat" });

        const slices: any[] = [
            { origin: params.origin, destination: params.destination, departure_date: params.departDate },
        ];
        if (params.returnDate) {
            slices.push({
                origin: params.destination,
                destination: params.origin,
                departure_date: params.returnDate,
            });
        }

        const r = await duffelFetch<any>(
            `/air/offer_requests?return_offers=true&supplier_timeout=15000`,
            {
                method: "POST",
                body: {
                    slices,
                    passengers,
                    cabin_class: params.cabin ?? "economy",
                    max_connections: 2,
                },
            },
        );
        if (!r.ok || !r.data) {
            logger.warn({ status: r.status, errors: r.errors }, "duffel search failed");
            return [];
        }
        const offers: any[] = r.data.offers ?? [];
        return Promise.all(offers.slice(0, params.maxResults ?? 200).map(mapOffer));
    },

    async priceCheck(offer: FlightOffer): Promise<PriceCheckResult> {
        const r = await duffelFetch<any>(`/air/offers/${encodeURIComponent(offer.offerId)}`);
        if (!r.ok || !r.data) {
            return { ok: false, reason: r.status === 404 ? "expired" : "provider_error" };
        }
        const fresh = await mapOffer(r.data);
        if (fresh.expiresAt && new Date(fresh.expiresAt).getTime() < Date.now()) {
            return { ok: false, reason: "expired" };
        }
        const delta = fresh.totalCents - offer.totalCents;
        return { ok: true, offer: fresh, deltaCents: delta, reason: delta !== 0 ? "price_changed" : undefined };
    },

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
        // Duffel cere id-urile pasagerilor din ofertă.
        const offerPassengers: any[] = (input.offer.raw?.passengers as any[]) ?? [];
        const passengers = input.passengers.map((p, i) => ({
            id: offerPassengers[i]?.id,
            title: p.title ?? "mr",
            given_name: p.givenName,
            family_name: p.familyName,
            born_on: p.bornOn,
            gender: p.gender ?? "m",
            email: p.email ?? input.contactEmail,
            phone_number: p.phone ?? input.contactPhone,
        }));

        const r = await duffelFetch<any>(`/air/orders`, {
            method: "POST",
            body: {
                type: "instant",
                selected_offers: [input.offer.offerId],
                passengers,
                payments: [
                    {
                        type: "balance",
                        amount: (input.offer.providerTotalCents / 100).toFixed(2),
                        // Plătim furnizorul în moneda LUI (EUR/GBP…), nu în RON-ul afișat clientului.
                        currency: input.offer.providerCurrency ?? input.offer.currency,
                    },
                ],
            },
        });
        if (!r.ok || !r.data) {
            const msg = r.errors?.[0]?.message ?? `duffel order failed (${r.status})`;
            logger.error({ status: r.status, errors: r.errors }, "duffel order failed");
            return { ok: false, message: msg };
        }
        return {
            ok: true,
            providerOrderId: r.data.id,
            bookingRef: r.data.booking_reference,
        };
    },
};
