/**
 * POST /api/fly/search — căutare zboruri agregată (Duffel + Kiwi).
 * Public (nu cere login), rate-limited pe IP. Prețurile returnate includ
 * markup-ul Swypik; fiecare ofertă are un `token` (cache Redis 15 min)
 * folosit la price-check și booking — clientul nu trimite niciodată prețul.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { searchFlights, activeProviders } from "@/lib/fly/service";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";
import { flyBookingGuard } from "@/lib/fly/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IATA = /^[A-Za-z]{3}$/;
const searchSchema = z.object({
    origin: z.string().regex(IATA, "cod IATA invalid"),
    destination: z.string().regex(IATA, "cod IATA invalid"),
    departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    adults: z.number().int().min(1).max(9).default(1),
    children: z.number().int().min(0).max(8).default(0),
    infants: z.number().int().min(0).max(4).default(0),
    cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
});

export async function POST(req: Request) {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const rl = await rateLimit("fly:search", getClientIP(req), { limit: 20, window: 60 });
    if (!rl.success) {
        return NextResponse.json({ error: "Prea multe căutări. Încearcă peste un minut." }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "date invalide" }, { status: 400 });
    }
    const p = parsed.data;
    if (p.origin.toUpperCase() === p.destination.toUpperCase()) {
        return NextResponse.json({ error: "Origine și destinație identice" }, { status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (p.departDate < today) {
        return NextResponse.json({ error: "Data de plecare e în trecut" }, { status: 400 });
    }
    if (p.returnDate && p.returnDate < p.departDate) {
        return NextResponse.json({ error: "Data de întoarcere e înainte de plecare" }, { status: 400 });
    }
    if (activeProviders().length === 0) {
        return NextResponse.json({ error: "Niciun furnizor de zboruri configurat" }, { status: 503 });
    }

    try {
        const result = await searchFlights({
            origin: p.origin.toUpperCase(),
            destination: p.destination.toUpperCase(),
            departDate: p.departDate,
            returnDate: p.returnDate ?? null,
            adults: p.adults,
            children: p.children,
            infants: p.infants,
            cabin: p.cabin,
            currency: "EUR",
            maxResults: 200,
        });
        // Public: DOAR prețul final. Costul furnizorului și marja Swypik sunt
        // interne — nu se expun niciodată în API (vizibile altfel în DevTools).
        return NextResponse.json({
            ...result,
            offers: result.offers.map(
                ({ providerTotalCents, markupCents, providerCurrency, raw, ...pub }) => pub,
            ),
        });
    } catch (err) {
        logger.error({ err, route: "/api/fly/search" }, "fly search failed");
        return NextResponse.json({ error: "Căutarea a eșuat. Reîncearcă." }, { status: 502 });
    }
}
