/**
 * POST /api/fly/orders — pornește rezervarea (wallet sau Stripe).
 *   Body: { token, passengers[], contactEmail, contactPhone, paymentMethod }.
 *   Face price-check live intern; dacă prețul s-a schimbat răspunde 409 cu
 *   noul total (clientul reconfirmă). Wallet: debit idempotent + ticketing +
 *   refund automat la eșec. Stripe: redirect la Checkout, fulfill în webhook.
 *
 * GET /api/fly/orders — istoricul rezervărilor userului curent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { startBooking, listUserBookings } from "@/lib/fly/booking";
import { logger } from "@/lib/logger";
import { flyBookingGuard } from "@/lib/fly/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const passengerSchema = z.object({
    type: z.enum(["adult", "child", "infant_without_seat"]).default("adult"),
    title: z.enum(["mr", "ms", "mrs", "miss"]).optional(),
    givenName: z.string().trim().min(1).max(60),
    familyName: z.string().trim().min(1).max(60),
    bornOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    gender: z.enum(["m", "f"]).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(6).max(20).optional(),
});

const orderSchema = z.object({
    token: z.string().uuid(),
    passengers: z.array(passengerSchema).min(1).max(9),
    contactEmail: z.string().email(),
    contactPhone: z.string().min(6).max(20),
    paymentMethod: z.enum(["wallet", "stripe"]),
});

export async function POST(req: Request) {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ error: "Autentifică-te pentru a rezerva" }, { status: 401 });

    const rl = await rateLimit("fly:order", session.userId, { limit: 5, window: 600 });
    if (!rl.success) return NextResponse.json({ error: "Prea multe încercări de rezervare" }, { status: 429 });

    const parsed = orderSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "date invalide" }, { status: 400 });
    }

    try {
        const result = await startBooking({
            userId: session.userId,
            offerToken: parsed.data.token,
            passengers: parsed.data.passengers,
            contactEmail: parsed.data.contactEmail,
            contactPhone: parsed.data.contactPhone,
            paymentMethod: parsed.data.paymentMethod,
        });

        if (!result.ok) {
            switch (result.code) {
                case "price_changed":
                    return NextResponse.json(
                        { error: "Prețul s-a schimbat", code: result.code, newTotalCents: result.newTotalCents, deltaCents: result.deltaCents },
                        { status: 409 },
                    );
                case "offer_expired":
                    return NextResponse.json({ error: "Oferta a expirat. Reia căutarea.", code: result.code }, { status: 410 });
                case "insufficient_funds":
                    return NextResponse.json({ error: "Fonduri insuficiente în wallet", code: result.code }, { status: 402 });
                default:
                    return NextResponse.json({ error: result.message ?? "Emiterea biletului a eșuat", code: result.code }, { status: 502 });
            }
        }

        if (result.status === "stripe_redirect") {
            return NextResponse.json({ ok: true, bookingId: result.bookingId, checkoutUrl: result.checkoutUrl });
        }
        return NextResponse.json({ ok: true, bookingId: result.bookingId, status: "ticketed", bookingRef: result.bookingRef });
    } catch (err) {
        logger.error({ err, route: "/api/fly/orders" }, "fly order failed");
        return NextResponse.json({ error: "Rezervarea a eșuat" }, { status: 500 });
    }
}

export async function GET() {
    const closed = flyBookingGuard();
    if (closed) return closed;
    const session = await getAuthSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const bookings = await listUserBookings(session.userId);
    return NextResponse.json({ bookings });
}
