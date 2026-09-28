/**
 * RateHawk (Emerging Travel Group) — client B2B pentru cazări.
 * Docs: https://docs.emergingtravel.com/ (API b2b v3, api.worldota.net).
 *
 * Autentificare: HTTP Basic cu RATEHAWK_KEY_ID:RATEHAWK_API_KEY.
 * Fără chei setate → isRateHawkConfigured() = false, provider-ul nu e folosit.
 *
 * Model identic cu Fly/Duffel: RateHawk dă costul NET (tarif b2b), Swypik e
 * merchant of record și adaugă marja (10% + podea) peste costul convertit în
 * RON. Costul net NU se expune niciodată în API-ul public.
 *
 * Flux: search (serp/geo) → hotelpage (hp) → prebook (garantează prețul,
 * echivalentul quote-ului Duffel) → booking form + finish.
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

const BASE = "https://api.worldota.net/api/b2b/v3";

export function isRateHawkConfigured(): boolean {
    return Boolean(process.env.RATEHAWK_KEY_ID && process.env.RATEHAWK_API_KEY);
}

function authHeader(): string {
    const raw = `${process.env.RATEHAWK_KEY_ID}:${process.env.RATEHAWK_API_KEY}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function rhFetch<T>(
    path: string,
    body: unknown,
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    if (!isRateHawkConfigured()) {
        return { ok: false, status: 401, error: "RATEHAWK_KEY_ID / RATEHAWK_API_KEY lipsă" };
    }
    let r: Response;
    try {
        r = await fetch(`${BASE}${path}`, {
            method: "POST",
            headers: {
                Authorization: authHeader(),
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(25000),
        });
    } catch (err) {
        // Fără acest catch, un abort de timeout urca necontextualizat până la
        // handler-ul de erori — "[Error [TimeoutError]: ...]" fără nicio urmă
        // că sursa era RateHawk.
        logger.warn({ err, path }, "[ratehawk] fetch failed or timed out");
        return { ok: false, status: 599, error: "ratehawk_unreachable" };
    }
    const json = (await r.json().catch(() => ({}))) as any;
    // RateHawk răspunde mereu 200 cu {status:"ok"|"error"} — verificăm ambele.
    const ok = r.ok && json?.status === "ok";
    return {
        ok,
        status: r.status,
        data: json?.data as T,
        error: ok ? undefined : (json?.error ?? `HTTP ${r.status}`),
    };
}

function nightsBetween(a: string, b: string): number {
    return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

function toCents(amount: string | number): number {
    return Math.round(Number(amount) * 100);
}

/** Extrage cel mai ieftin tarif dintr-un hotel din răspunsul serp. */
function cheapestRate(hotel: any): { amount: number; currency: string; hash: string } | null {
    const rates: any[] = hotel?.rates ?? [];
    let best: { amount: number; currency: string; hash: string } | null = null;
    for (const rate of rates) {
        const pt = rate?.payment_options?.payment_types?.[0];
        if (!pt) continue;
        const amount = Number(pt.amount);
        if (!Number.isFinite(amount)) continue;
        if (!best || amount < best.amount) {
            best = { amount, currency: pt.currency_code ?? "EUR", hash: rate.book_hash ?? "" };
        }
    }
    return best;
}

/** Căutare cazări după coordonate (serp/geo). */
export async function searchStaysRateHawk(params: StaySearchParams): Promise<StayResult[]> {
    const r = await rhFetch<any>("/search/serp/geo/", {
        longitude: params.lng,
        latitude: params.lat,
        radius: Math.round((params.radiusKm ?? 8) * 1000), // metri
        checkin: params.checkIn,
        checkout: params.checkOut,
        residency: "ro",
        language: "ro",
        currency: "EUR",
        guests: [{ adults: params.adults, children: [] }],
    });

    if (!r.ok || !r.data) {
        logger.warn({ status: r.status, error: r.error }, "stays(ratehawk): search failed");
        return [];
    }

    const nights = nightsBetween(params.checkIn, params.checkOut);
    const hotels: any[] = (r.data as any).hotels ?? [];

    const out: StayResult[] = [];
    for (const h of hotels) {
        const rate = cheapestRate(h);
        if (!rate) continue;
        const providerTotalCents = toCents(rate.amount);
        const ronCost = await toRonCents(providerTotalCents, rate.currency);
        const markup = computeMarkupRonCents(ronCost);
        const staticInfo = h.static_vm ?? h; // unele răspunsuri includ date statice
        out.push({
            provider: "ratehawk",
            // book_hash identifică rata la prebook; hotel id păstrat separat.
            searchResultId: rate.hash,
            accommodationId: h.id ?? h.hid?.toString() ?? "",
            name: staticInfo.name ?? h.id ?? "Cazare",
            stars: staticInfo.star_rating ?? null,
            photoUrl: staticInfo.images?.[0]?.replace("{size}", "640x400") ?? null,
            address: staticInfo.address ?? null,
            lat: staticInfo.latitude ?? null,
            lng: staticInfo.longitude ?? null,
            providerTotalCents,
            providerCurrency: rate.currency,
            totalCents: ronCost + markup,
            markupCents: markup,
            currency: "RON",
            nights,
            checkIn: params.checkIn,
            checkOut: params.checkOut,
        });
    }
    return out;
}

/**
 * Prebook — echivalentul quote-ului Duffel: garantează prețul pentru un
 * book_hash înainte de plată. Prețul poate diferi de cel din search
 * (price change) — întoarcem mereu valoarea din prebook.
 */
export async function createQuoteRateHawk(bookHash: string): Promise<StayQuote | null> {
    const r = await rhFetch<any>("/hotel/prebook/", { hash: bookHash, price_increase_percent: 0 });
    if (!r.ok || !r.data) {
        logger.warn({ status: r.status, error: r.error }, "stays(ratehawk): prebook failed");
        return null;
    }
    const hotel = (r.data as any).hotels?.[0];
    const rate = hotel?.rates?.[0];
    const pt = rate?.payment_options?.payment_types?.[0];
    if (!rate || !pt) return null;

    const providerCurrency = pt.currency_code ?? "EUR";
    const providerTotalCents = toCents(pt.amount ?? 0);
    const ronCost = await toRonCents(providerTotalCents, providerCurrency);
    const markup = computeMarkupRonCents(ronCost);
    const freeCancelBefore = pt.cancellation_penalties?.free_cancellation_before ?? null;

    return {
        // book_hash-ul NOU din prebook e cel valid pentru booking.
        quoteId: rate.book_hash ?? bookHash,
        accommodationName: hotel?.name ?? "Cazare",
        roomName: rate.room_name ?? null,
        boardType: rate.meal ?? null,
        cancellationDeadline: freeCancelBefore,
        providerTotalCents,
        providerCurrency,
        totalCents: ronCost + markup,
        markupCents: markup,
        currency: "RON",
        checkIn: rate.checkin ?? "",
        checkOut: rate.checkout ?? "",
    };
}

/**
 * Booking în doi pași: order/booking/form (creează comanda pe book_hash)
 * apoi order/booking/finish (trimite oaspeții + plata de tip "deposit" —
 * facturat pe contractul b2b, NU card client).
 */
export async function createStayBookingRateHawk(
    input: CreateStayBookingInput,
): Promise<CreateStayBookingResult> {
    const form = await rhFetch<any>("/hotel/order/booking/form/", {
        partner_order_id: input.reference,
        book_hash: input.quoteId,
        language: "ro",
        user_ip: "127.0.0.1",
    });
    if (!form.ok || !form.data) {
        return { ok: false, error: form.error ?? "booking form eșuat" };
    }
    const orderId = (form.data as any).order_id;

    const finish = await rhFetch<any>("/hotel/order/booking/finish/", {
        user: { email: input.email, phone: input.phone, comment: null },
        partner: { partner_order_id: input.reference },
        language: "ro",
        rooms: [
            {
                guests: input.guests.map((g) => ({
                    first_name: g.givenName,
                    last_name: g.familyName,
                })),
            },
        ],
        payment_type: {
            type: "deposit",
            amount: null,
            currency_code: null,
        },
    });
    if (!finish.ok) {
        return { ok: false, error: finish.error ?? "booking finish eșuat" };
    }
    return {
        ok: true,
        bookingId: String(orderId ?? input.reference),
        confirmationCode: null, // statusul final vine async — de verificat cu order/booking/finish/status
    };
}

/** Verifică statusul final al unei rezervări (procesarea e asincronă). */
export async function getBookingStatusRateHawk(
    partnerOrderId: string,
): Promise<{ status: "ok" | "processing" | "error"; error?: string }> {
    const r = await rhFetch<any>("/hotel/order/booking/finish/status/", {
        partner_order_id: partnerOrderId,
    });
    if (r.ok) return { status: "ok" };
    if (r.error === "processing" || r.status === 425) return { status: "processing" };
    return { status: "error", error: r.error };
}
