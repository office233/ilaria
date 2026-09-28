/**
 * Rezervări pe ore (servicii: frizerii, cabinete, terenuri, service auto).
 *
 * POST /api/bookings/slots  → rezervă un interval orar.
 *   Suprapunerea e imposibilă: EXCLUDE constraint pe (product_id, slot_date, timerange).
 * GET  /api/bookings/slots?product_id=&date=  → intervalele ocupate (public).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { BookingSlotCreateSchema, parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ProductRow {
  id: string;
  currency: string | null;
  status: string;
  vertical_attributes: Record<string, unknown> | null;
}

function isOverlapError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "23P01" || code === "23505";
}

async function GET_impl(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id")?.trim();
  if (!productId || !/^[0-9a-f-]{36}$/i.test(productId)) {
    return NextResponse.json({ success: false, error: "product_id invalid" }, { status: 400 });
  }
  const date = url.searchParams.get("date")?.trim();

  const where: string[] = ["product_id = $1", "status IN ('pending','confirmed')"];
  const params: unknown[] = [productId];
  if (date && DATE_RE.test(date)) {
    params.push(date);
    where.push(`slot_date = $${params.length}`);
  } else {
    where.push("slot_date >= CURRENT_DATE");
  }

  const { rows } = await dbQuery(
    `SELECT slot_date, start_time, end_time, status
       FROM booking_slots
      WHERE ${where.join(" AND ")}
      ORDER BY slot_date ASC, start_time ASC
      LIMIT 500`,
    params,
  );
  return NextResponse.json({ success: true, slots: rows });
}

async function POST_impl(req: Request): Promise<Response> {
  const session = await getAuthSession();

  const identifier = session ? `user:${session.userId}` : "anon";
  const rl = await rateLimit("cart", `slot:${identifier}`, { limit: 10, window: 600 });
  if (!rl.success) {
    return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
  }

  const body: unknown = await req.json().catch(() => null);
  const parsed = parseBody(BookingSlotCreateSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error, issues: parsed.issues }, { status: 400 });
  }
  const d = parsed.data;

  // Nu se rezervă în trecut.
  if (new Date(`${d.slot_date}T${d.end_time}:00`) < new Date()) {
    return NextResponse.json({ success: false, error: "Intervalul este în trecut." }, { status: 400 });
  }

  const { rows: pRows } = await dbQuery<ProductRow>(
    `SELECT id, currency, status, vertical_attributes
       FROM marketplace_products WHERE id = $1`,
    [d.product_id],
  );
  if (pRows.length === 0 || pRows[0].status !== "active") {
    return NextResponse.json({ success: false, error: "Serviciul nu este disponibil." }, { status: 404 });
  }

  // Prețul se calculează server-side din atributele produsului.
  const attrs = pRows[0].vertical_attributes ?? {};
  const rawHourly = attrs.price_per_hour ?? attrs.price_cents ?? 0;
  const hourlyCents = typeof rawHourly === "number" && Number.isFinite(rawHourly) ? Math.max(0, Math.round(rawHourly)) : 0;
  const startMin = Number(d.start_time.slice(0, 2)) * 60 + Number(d.start_time.slice(3, 5));
  const endMin = Number(d.end_time.slice(0, 2)) * 60 + Number(d.end_time.slice(3, 5));
  const priceCents = Math.round((hourlyCents * (endMin - startMin)) / 60);

  try {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO booking_slots
         (product_id, customer_user_id, customer_name, customer_phone, customer_email,
          slot_date, start_time, end_time, price_cents, currency, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
       RETURNING id`,
      [
        d.product_id, session?.userId ?? null, d.customer_name,
        d.customer_phone ?? null, d.customer_email ?? null,
        d.slot_date, d.start_time, d.end_time,
        priceCents, pRows[0].currency ?? "RON", d.notes ?? null,
      ],
    );

    logger.info({ slotId: rows[0].id, product_id: d.product_id }, "[bookings] slot reserved");
    return NextResponse.json(
      {
        success: true,
        booking: {
          id: rows[0].id,
          slot_date: d.slot_date,
          start_time: d.start_time,
          end_time: d.end_time,
          price_cents: priceCents,
          status: "pending",
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (isOverlapError(err)) {
      return NextResponse.json({ success: false, error: "Intervalul este deja rezervat." }, { status: 409 });
    }
    throw err;
  }
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
