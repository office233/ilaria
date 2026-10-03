/**
 * Swypik Stays — strat de provider unificat.
 *
 * Alege automat furnizorul activ (RateHawk are prioritate dacă e configurat,
 * altfel Duffel Stays) și expune o interfață unică pentru rute. Rutele NU
 * importă clienții direct — doar acest modul.
 *
 * Reguli de business (identice indiferent de furnizor):
 *  - costul net al furnizorului NU se expune public
 *  - marja Swypik (10% + podea) se aplică pe costul convertit în RON
 *  - Swypik e merchant of record; fără redirecturi către terți, niciodată
 */
import {
    createQuote as duffelQuote,
    createStayBooking as duffelBook,
    isStaysConfigured as duffelConfigured,
    searchStays as duffelSearch,
    StaysAccessError,
} from "./duffel";
import {
    createQuoteRateHawk,
    createStayBookingRateHawk,
    isRateHawkConfigured,
    searchStaysRateHawk,
} from "./ratehawk";
import {
    CreateStayBookingInput,
    CreateStayBookingResult,
    StayProviderId,
    StayQuote,
    StayResult,
    StaySearchParams,
} from "./types";

export { StaysAccessError };

/** Furnizorul activ sau null dacă niciunul nu e configurat. */
export function activeStayProvider(): StayProviderId | null {
    if (isRateHawkConfigured()) return "ratehawk";
    if (duffelConfigured()) return "duffel";
    return null;
}

/** true dacă există cel puțin un furnizor extern configurat. */
export function isExternalStaysConfigured(): boolean {
    return activeStayProvider() !== null;
}

export async function searchExternalStays(params: StaySearchParams): Promise<StayResult[]> {
    const p = activeStayProvider();
    if (p === "ratehawk") return searchStaysRateHawk(params);
    if (p === "duffel") return duffelSearch(params);
    return [];
}

export async function quoteExternalStay(
    provider: StayProviderId,
    rateId: string,
): Promise<StayQuote | null> {
    if (provider === "ratehawk") return createQuoteRateHawk(rateId);
    return duffelQuote(rateId);
}

export async function bookExternalStay(
    provider: StayProviderId,
    input: CreateStayBookingInput,
): Promise<CreateStayBookingResult> {
    if (provider === "ratehawk") return createStayBookingRateHawk(input);
    return duffelBook(input);
}
