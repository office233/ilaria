/**
 * Swypik Stays — tipuri comune. Model identic cu Fly: furnizorul dă cost net,
 * Swypik e merchant of record, marja (10% + podea) se adaugă peste, totul în RON.
 */

/** Furnizori suportați pentru cazări externe. */
export type StayProviderId = "duffel" | "ratehawk";

export type StaySearchParams = {
    /** Coordonate centru căutare (oraș). */
    lat: number;
    lng: number;
    radiusKm?: number;
    checkIn: string; // YYYY-MM-DD
    checkOut: string; // YYYY-MM-DD
    adults: number;
    rooms?: number;
};

export type StayResult = {
    provider: StayProviderId;
    /** id rezultat căutare (folosit la fetch rates). */
    searchResultId: string;
    accommodationId: string;
    name: string;
    stars: number | null;
    photoUrl: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
    /** Cost net furnizor (cenți, moneda furnizorului). */
    providerTotalCents: number;
    providerCurrency: string;
    /** Preț final client în bani RON (cost convertit + marjă). */
    totalCents: number;
    markupCents: number;
    currency: "RON";
    nights: number;
    checkIn: string;
    checkOut: string;
};

export type StayQuote = {
    quoteId: string;
    accommodationName: string;
    roomName: string | null;
    boardType: string | null; // ex: room_only, breakfast
    cancellationDeadline: string | null;
    providerTotalCents: number;
    providerCurrency: string;
    totalCents: number; // RON bani, cu marjă
    markupCents: number;
    currency: "RON";
    checkIn: string;
    checkOut: string;
};

export type StayGuest = {
    givenName: string;
    familyName: string;
};

export type CreateStayBookingInput = {
    quoteId: string;
    guests: StayGuest[];
    email: string;
    phone: string;
    /** Referință internă idempotentă. */
    reference: string;
};

export type CreateStayBookingResult = {
    ok: boolean;
    bookingId?: string; // id la furnizor
    confirmationCode?: string | null;
    error?: string;
};
