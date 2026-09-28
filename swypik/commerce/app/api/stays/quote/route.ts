/**
 * GET /api/stays/quote?productId=..&checkIn=..&checkOut=..&guests=..
 * Preț + disponibilitate pentru un interval (fără efecte). Motivul
 * indisponibilității e un cod stabil (`reason`), tradus în client.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { quoteStay } from "@/lib/stays/booking";
import { staysError } from "@/lib/stays/errors";
import { limitOrThrow, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
    productId: z.string().uuid(),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    guests: z.coerce.number().int().min(1).max(50).default(1),
});

export const GET = staysRoute("stays/quote", async (req: Request) => {
    await limitOrThrow(req, "quote", null, { limit: 60, window: 60 });
    const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
    if (!parsed.success) return staysError("invalid_input");
    const { productId, checkIn, checkOut, guests } = parsed.data;
    const q = await quoteStay(productId, checkIn, checkOut, guests);
    return NextResponse.json({
        available: q.available,
        reason: q.reason,
        nights: q.nights,
        pricePerNightCents: q.pricePerNightCents,
        totalCents: q.totalCents,
        currency: q.currency,
        maxGuests: q.maxGuests,
    });
});
