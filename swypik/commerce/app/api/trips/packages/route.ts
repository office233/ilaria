/**
 * GET /api/trips/packages?origin=OTP — pachete de vacanță pe destinații.
 *
 * Acum: zbor live (Duffel, prețuri finale RON din sistemul Fly) + status
 * cazare (Duffel Stays — "curând" până se activează pe cont). Când Stays
 * devine activ, prețul pachetului devine zbor+hotel real, tot merchant Swypik.
 * Zero afiliere, zero linkuri externe.
 */
import { NextResponse } from "next/server";
import { isExternalStaysConfigured } from "@/lib/stays/provider";
import { getFlyDeals } from "@/lib/fly/deals-service";
import { flyBookingGuard } from "@/lib/fly/gate";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Zile de vacanță tipice pe destinație (city-break vs sejur). */
const TRIP_NIGHTS: Record<string, number> = {
    VIE: 3, ROM: 4, FCO: 4, PAR: 4, CDG: 4, BCN: 4, MAD: 4, LIS: 5,
    ATH: 5, IST: 4, DXB: 6, JFK: 7, AMS: 3, LON: 4, LHR: 4,
};

export async function GET(req: Request) {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const origin = (new URL(req.url).searchParams.get("origin") ?? "OTP").toUpperCase();

    // Refolosim cache-ul deals fără apel HTTP loopback (in-process direct)
    const { deals, departDate } = await getFlyDeals(origin);

    const packages = deals.map((d) => ({
        iata: d.iata,
        city: d.city,
        country: d.country,
        image: d.image,
        nights: TRIP_NIGHTS[d.iata] ?? 4,
        flightFromCents: d.fromCents,
        currency: d.currency ?? "EUR",
        staysAvailable: isExternalStaysConfigured(),
        departDate,
    }));

    return applyCachePolicy(
        NextResponse.json({ origin, packages, staysComingSoon: !isExternalStaysConfigured() }),
        "trips/packages",
        req,
    );
}

