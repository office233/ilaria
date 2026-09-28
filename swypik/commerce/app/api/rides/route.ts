/**
 * Swypik Go — curse.
 *
 * POST /api/rides — creează cursa ('requested'). Prețul e calculat EXCLUSIV
 *   server-side (pricing engine); clientul nu trimite niciodată preț.
 *   - cash (dacă e activat în go_settings): dispatch imediat → 'searching';
 *   - card: NU pornește dispatch-ul; clientul autorizează plata (POST
 *     /api/rides/[id]/pay) și abia după hold-ul verificat pleacă dispatch-ul.
 * GET  /api/rides — istoricul riderului logat (paginat).
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { dbQuery, withTransaction } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { estimate } from "@/lib/pricing/engine";
import { resolveRideZone, NoZoneError } from "@/lib/rides/city";
import { startRideDispatch } from "@/lib/rides/dispatch-start";
import { getGoSettings } from "@/lib/rides/settings";
import { allowedPaymentMethods } from "@/lib/rides/policy";
import { riderHasOwedFees } from "@/lib/rides/cancel-fee";
import { stripeConfigured } from "@/lib/payments/mobility-stripe";
import { RideCreateSchema } from "@/lib/validation/rides";
import { paginationSchema, queryObject } from "@/lib/validation/params";
import { parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "rides" });

async function activeRideId(userId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM rides WHERE rider_user_id = $1 AND status NOT IN ('completed','cancelled') LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export async function POST(req: Request) {
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("rideCreate", session.userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const parsed = parseBody(RideCreateSchema, await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const input = parsed.data;

  // O singură cursă activă per rider — verificare rapidă (fără lock); cea
  // atomică e mai jos, în tranzacția de insert (audit #13: dublu-tap → 2 curse).
  const existing = await activeRideId(session.userId);
  if (existing) return NextResponse.json({ error: "active_ride", ride_id: existing }, { status: 409 });

  const settings = await getGoSettings();
  const methods = allowedPaymentMethods(settings, {
    stripeConfigured: stripeConfigured(),
    hasOwedFees: await riderHasOwedFees(session.userId),
  });
  if (!methods.includes(input.payment_method)) {
    return NextResponse.json({ error: "payment_method_unavailable", allowed: methods }, { status: 422 });
  }

  let zone;
  let est;
  try {
    zone = await resolveRideZone(input.pickup, input.vehicle_class, input.country);
    est = await estimate({
      city: zone.city,
      country: input.country,
      kind: "ride",
      vehicle_class: input.vehicle_class,
      pickup: { lat: input.pickup.lat, lng: input.pickup.lng },
      dropoff: { lat: input.dropoff.lat, lng: input.dropoff.lng },
    });
  } catch (err) {
    if (err instanceof NoZoneError || (err as Error).message === "no_zone") {
      return NextResponse.json({ error: "no_zone", code: "no_zone" }, { status: 422 });
    }
    throw err;
  }

  const inserted = await withTransaction(async (q) => {
    // Lock per rider pe durata tranzacției: două cereri simultane se serializează,
    // a doua vede cursa primei. Indexul unic parțial (migrarea 20260928_41) e plasa.
    await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ride_rider:${session.userId}`]);
    const { rows: active } = await q<{ id: string }>(
      `SELECT id FROM rides WHERE rider_user_id = $1 AND status NOT IN ('completed','cancelled') LIMIT 1`,
      [session.userId],
    );
    if (active.length) return { conflict: active[0].id } as const;
    const { rows } = await q<{ id: string }>(
    `INSERT INTO rides
       (rider_user_id, city, vehicle_class, pricing_zone_id,
        pickup_address, pickup_lat, pickup_lng,
        dropoff_address, dropoff_lat, dropoff_lng,
        status, estimated_fare_cents, currency,
        distance_km, duration_min, surge_multiplier, fare_breakdown,
        payment_method, share_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      session.userId,
      zone.city,
      input.vehicle_class,
      est.zone_id,
      input.pickup.address,
      input.pickup.lat,
      input.pickup.lng,
      input.dropoff.address,
      input.dropoff.lat,
      input.dropoff.lng,
      est.total_cents,
      est.currency,
      est.distance_km,
      est.duration_min,
      est.breakdown.surge_multiplier,
      JSON.stringify(est.breakdown),
      input.payment_method,
      randomBytes(16).toString("hex"),
    ],
  );
    return { id: rows[0].id } as const;
  }).catch((err: unknown) => {
    if ((err as { code?: string })?.code === "23505") return { conflict: "" } as const;
    throw err;
  });
  if ("conflict" in inserted) {
    const rideId = inserted.conflict || (await activeRideId(session.userId));
    return NextResponse.json({ error: "active_ride", ride_id: rideId }, { status: 409 });
  }
  const rideId = inserted.id;

  // Cash: dispatch imediat. Card: dispatch doar după autorizarea verificată.
  const started = input.payment_method === "cash" ? await startRideDispatch(rideId) : null;
  log.info({ rideId, method: input.payment_method, dispatch: Boolean(started) }, "ride created");
  return NextResponse.json(
    {
      ride_id: rideId,
      status: started ? "searching" : "requested",
      requires_payment: input.payment_method === "card",
      estimated_fare_cents: est.total_cents,
      currency: est.currency,
    },
    { status: 201 },
  );
}

const HistoryQuery = paginationSchema(20, 50);

export async function GET(req: Request) {
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = HistoryQuery.safeParse(queryObject(new URL(req.url), ["limit", "offset"]));
  if (!q.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });

  const { rows } = await dbQuery(
    `SELECT r.id, r.status, r.vehicle_class, r.pickup_address, r.dropoff_address,
            r.estimated_fare_cents, r.final_fare_cents, r.currency, r.payment_method,
            r.cancel_fee_cents, r.cancel_fee_status,
            r.distance_km, r.duration_min, r.requested_at, r.completed_at,
            c.full_name AS driver_name, c.rating AS driver_rating
       FROM rides r
       LEFT JOIN couriers c ON c.id = r.driver_id
      WHERE r.rider_user_id = $1
      ORDER BY r.requested_at DESC
      LIMIT $2 OFFSET $3`,
    [session.userId, q.data.limit, q.data.offset],
  );
  return NextResponse.json({ rides: rows });
}
