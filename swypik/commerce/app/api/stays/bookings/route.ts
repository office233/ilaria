/**
 * Rezervări Stays.
 *
 * POST /api/stays/bookings — cerere de rezervare (DOAR utilizatori logați;
 *   anonimii blocau calendarul, audit „calendar DoS”). Creează un hold
 *   'pending' care expiră dacă nu se plătește (STAYS_PENDING_TTL_MIN).
 * GET  /api/stays/bookings?product_id=… — nopțile ocupate/blocate (calendar public).
 * GET  /api/stays/bookings?mine=1 — rezervările clientului logat.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { createBookingRequest } from "@/lib/stays/booking";
import { listGuestBookings } from "@/lib/stays/bookings-repo";
import { addDays, todayIso } from "@/lib/stays/dates";
import { staysError } from "@/lib/stays/errors";
import { limitOrThrow, requireSession, staysRoute, UUID_RE } from "@/lib/stays/route";
import { BLOCKING_BOOKING_SQL } from "@/lib/stays/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const createSchema = z
    .object({
        product_id: z.string().uuid(),
        check_in: z.string().regex(DATE),
        check_out: z.string().regex(DATE),
        guests_count: z.number().int().min(1).max(50),
        guest_name: z.string().trim().min(2).max(120),
        guest_email: z.string().trim().email().max(254).optional(),
        guest_phone: z.string().trim().min(5).max(32).optional(),
    })
    .refine((d) => Boolean(d.guest_email || d.guest_phone));

export const POST = staysRoute("stays/bookings:create", async (req: Request) => {
    const session = await requireSession();
    await limitOrThrow(req, "book", session.userId, { limit: 10, window: 3600 });
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return staysError("invalid_input");
    const d = parsed.data;
    const booking = await createBookingRequest({
        productId: d.product_id,
        userId: session.userId,
        guestName: d.guest_name,
        guestEmail: d.guest_email ?? null,
        guestPhone: d.guest_phone ?? null,
        checkIn: d.check_in,
        checkOut: d.check_out,
        guests: d.guests_count,
    });
    return NextResponse.json({ ok: true, booking });
});

export const GET = staysRoute("stays/bookings:get", async (req: Request) => {
    const url = new URL(req.url);
    if (url.searchParams.get("mine") === "1") {
        const session = await requireSession();
        return NextResponse.json({ bookings: await listGuestBookings(session.userId) });
    }
    const productId = url.searchParams.get("product_id") ?? "";
    if (!UUID_RE.test(productId)) return staysError("invalid_input");
    await limitOrThrow(req, "calendar", null, { limit: 60, window: 60 });

    const today = todayIso();
    const fromRaw = url.searchParams.get("from") ?? "";
    const toRaw = url.searchParams.get("to") ?? "";
    const from = DATE.test(fromRaw) && fromRaw >= today ? fromRaw : today;
    const to = DATE.test(toRaw) && toRaw > from && toRaw <= addDays(today, 400) ? toRaw : addDays(from, 365);

    const [booked, blocked] = await Promise.all([
        dbQuery<{ check_in: string; check_out: string }>(
            `SELECT b.check_in::text, b.check_out::text FROM stay_bookings b
              WHERE b.product_id = $1::uuid AND ${BLOCKING_BOOKING_SQL}
                AND b.check_out > $2::date AND b.check_in < $3::date`,
            [productId, from, to],
        ),
        dbQuery<{ day: string }>(
            `SELECT day::text AS day FROM stay_availability
              WHERE product_id = $1::uuid AND is_available = false AND day >= $2::date AND day < $3::date`,
            [productId, from, to],
        ),
    ]);
    return NextResponse.json({ from, to, booked: booked.rows, blockedDays: blocked.rows.map((r) => r.day) });
});
