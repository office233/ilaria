/**
 * Swypik Fly — tipuri comune pentru toți furnizorii (Duffel, Kiwi Tequila).
 * Orice provider nou trebuie doar să implementeze `FlightProvider`.
 */

export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export type FlightSearchParams = {
    origin: string; // IATA (ex: OTP)
    destination: string; // IATA (ex: BCN)
    departDate: string; // YYYY-MM-DD
    returnDate?: string | null;
    adults: number;
    children?: number;
    infants?: number;
    cabin?: CabinClass;
    currency?: string;
    maxResults?: number;
};

export type FlightSegment = {
    origin: string;
    destination: string;
    departAt: string; // ISO
    arriveAt: string; // ISO
    carrier: string; // IATA airline
    carrierName?: string;
    flightNumber?: string;
    durationMinutes?: number;
};

export type FlightSlice = {
    origin: string;
    destination: string;
    durationMinutes?: number;
    segments: FlightSegment[];
};

export type FlightOffer = {
    provider: ProviderId;
    offerId: string;
    /** Cost real la furnizor, în cenți. */
    providerTotalCents: number;
    /** Moneda în care ne facturează furnizorul (EUR/GBP/USD…). */
    providerCurrency: string;
    /** Markup Swypik aplicat (cenți). */
    markupCents: number;
    /** Ce plătește clientul (cenți). */
    totalCents: number;
    currency: string;
    slices: FlightSlice[];
    /** Numărul de escale pe cel mai lung slice. */
    stops: number;
    carrier: string;
    carrierName?: string;
    baggageIncluded?: boolean;
    expiresAt?: string | null;
    /** Payload brut necesar la booking (deep link Kiwi, passenger ids Duffel). */
    raw?: Record<string, unknown>;
};

export type PriceCheckResult = {
    ok: boolean;
    /** Oferta revalidată (poate avea preț diferit). */
    offer?: FlightOffer;
    /** Diferența față de prețul afișat inițial (poate fi negativă). */
    deltaCents?: number;
    reason?: "unavailable" | "expired" | "price_changed" | "provider_error";
    message?: string;
};

export type PassengerInput = {
    type: "adult" | "child" | "infant_without_seat";
    title?: "mr" | "ms" | "mrs" | "miss";
    givenName: string;
    familyName: string;
    bornOn: string; // YYYY-MM-DD
    gender?: "m" | "f";
    email?: string;
    phone?: string;
};

export type CreateOrderInput = {
    offer: FlightOffer;
    passengers: PassengerInput[];
    contactEmail: string;
    contactPhone: string;
};

export type CreateOrderResult = {
    ok: boolean;
    providerOrderId?: string;
    bookingRef?: string; // PNR
    message?: string;
};

export type ProviderId = "duffel" | "kiwi";

export interface FlightProvider {
    readonly id: ProviderId;
    isConfigured(): boolean;
    search(params: FlightSearchParams): Promise<FlightOffer[]>;
    priceCheck(offer: FlightOffer): Promise<PriceCheckResult>;
    createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
}

/**
 * Marja Swypik — PROCENT din costul biletului + prag minim, gândită să
 * acopere Stripe (~2% + 1,3 lei pe TOT biletul), TVA pe marjă (regim special
 * agenții art. 311), impozit pe profit și dividende, și să rămână profit.
 *
 * Env:
 *   FLY_MARKUP_PCT        — procent din preț (default 8)
 *   FLY_MARKUP_MIN_CENTS  — marjă minimă în cenți-EUR echivalent la nivel de
 *                           provider (folosită de repricing drept podea)
 *   FLY_MARKUP_FLOOR_RON  — prag minim în bani RON (default 1500 = 15 lei)
 */
export function markupPct(): number {
    const v = Number(process.env.FLY_MARKUP_PCT ?? 10);
    return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** Podea de marjă în bani RON (sub asta nu coborâm nici la bilete de 100 lei). */
export function markupFloorRonCents(): number {
    const v = Number(process.env.FLY_MARKUP_FLOOR_RON ?? 1500);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 1500;
}

/** Marja în bani RON pentru un cost de bilet dat (deja convertit în RON). */
export function computeMarkupRonCents(ticketRonCents: number): number {
    const pct = Math.round((ticketRonCents * markupPct()) / 100);
    return Math.max(markupFloorRonCents(), pct);
}

/** Suma decimală a providerului ("123.45") → cenți. */
export function toCents(amount: string | number): number {
    return Math.round(Number(amount) * 100);
}
