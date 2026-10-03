/**
 * Swypik Fly nu are furnizor de zboruri contractat (audit fly.md). Până atunci
 * toate căile de căutare/rezervare sunt închise în spatele FEATURE_FLY_BOOKING
 * (OFF implicit): rutele răspund 404 `fly_not_available`, iar /fly afișează
 * „în curând / anunță-mă” (lista de așteptare, /api/fly/waitlist).
 */
import { NextResponse } from "next/server";
import { isEnabled } from "@/lib/feature-flags";

export function isFlyBookingEnabled(): boolean {
    return isEnabled("flyBooking");
}

/** Răspunsul rutelor Fly de căutare/rezervare când modulul e închis; null = deschis. */
export function flyBookingGuard(): Response | null {
    if (isFlyBookingEnabled()) return null;
    return NextResponse.json({ error: "fly_not_available" }, { status: 404 });
}
