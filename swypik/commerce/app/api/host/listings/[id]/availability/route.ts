/**
 * Calendarul gazdei pentru o listare.
 * GET  ?from=&to= → zile blocate, prețuri speciale, intervale rezervate (active)
 * POST { dates[], available, priceCentsOverride? } → blochează/deblochează
 *      zile sau setează preț special (max 366/apel). Zilele cu rezervări
 *      active nu pot fi blocate.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { staysConfig } from "@/lib/stays/config";
import { addDays, todayIso } from "@/lib/stays/dates";
import { staysError } from "@/lib/stays/errors";
import { requireHost } from "@/lib/stays/hosts";
import { assertOwnsListing } from "@/lib/stays/listings";
import { idParam, limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";
import { BLOCKING_BOOKING_SQL } from "@/lib/stays/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Ctx = { params: Promise<{ id: string }> };

export const GET = staysRoute("host/availability:get", async (req: Request, ctx: Ctx) => {
    const session = await requireSession();
    const id = await idParam(ctx.params);
    await assertOwnsListing(id, session.userId);
    const sp = new URL(req.url).searchParams;
    const from = DATE.test(sp.get("from") ?? "") ? sp.get("from")! : todayIso();
    const to = DATE.test(sp.get("to") ?? "") ? sp.get("to")! : addDays(from, 92);

    const [days, booked] = await Promise.all([
        dbQuery<{ day: string; is_available: boolean; price_cents_override: number | null }>(
            `SELECT day::text, is_available, price_cents_override FROM stay_availability
              WHERE product_id = $1::uuid AND day >= $2::date AND day <= $3::date`,
            [id, from, to],
        ),
        dbQuery<{ check_in: string; check_out: string; status: string }>(
            `SELECT b.check_in::text, b.check_out::text, b.status FROM stay_bookings b
              WHERE b.product_id = $1::uuid AND ${BLOCKING_BOOKING_SQL}
                AND b.check_out > $2::date AND b.check_in <= $3::date`,
            [id, from, to],
        ),
    ]);
    return NextResponse.json({
        blockedDays: days.rows.filter((d) => !d.is_available).map((d) => d.day),
        pricedDays: days.rows.filter((d) => d.is_available && d.price_cents_override !== null),
        bookedRanges: booked.rows,
    });
});

export const POST = staysRoute("host/availability:post", async (req: Request, ctx: Ctx) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-calendar", session.userId, { limit: 120, window: 3600 });
    await requireHost(session.userId);
    const id = await idParam(ctx.params);
    await assertOwnsListing(id, session.userId);

    const parsed = z
        .object({
            dates: z.array(z.string().regex(DATE)).min(1).max(366),
            available: z.boolean(),
            priceCentsOverride: z
                .number()
                .int()
                .min(staysConfig.minPricePerNightCents())
                .max(staysConfig.maxPricePerNightCents())
                .nullable()
                .optional(),
        })
        .safeParse(await req.json().catch(() => null));
    if (!parsed.success) return staysError("invalid_input");
    const { dates, available, priceCentsOverride } = parsed.data;

    if (!available) {
        const clash = await dbQuery<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM stay_bookings b
              WHERE b.product_id = $1::uuid AND ${BLOCKING_BOOKING_SQL}
                AND EXISTS (SELECT 1 FROM unnest($2::date[]) d
                             WHERE d >= b.check_in AND d < b.check_out)`,
            [id, dates],
        );
        if (Number(clash.rows[0]?.n ?? 0) > 0) return staysError("dates_booked");
    }

    await dbQuery(
        `INSERT INTO stay_availability (product_id, day, is_available, price_cents_override)
         SELECT $1::uuid, d, $3, $4 FROM unnest($2::date[]) AS d
         ON CONFLICT (product_id, day)
         DO UPDATE SET is_available = EXCLUDED.is_available, price_cents_override = EXCLUDED.price_cents_override`,
        [id, dates, available, priceCentsOverride ?? null],
    );
    return NextResponse.json({ ok: true, updated: dates.length });
});
