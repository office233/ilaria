/**
 * GET /api/rides/[id] — detaliu cursă (rider, șoferul atribuit sau admin).
 * Include `cancel_policy` calculată server-side (taxa care s-ar aplica acum și
 * până când anularea e gratuită) — UI-ul nu mai duplică regula.
 */
import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { isUuidParam, invalidIdResponse } from "@/lib/validation/params";
import { loadRide, resolveRole, type RideRow } from "@/lib/rides/service";
import { getGoSettings } from "@/lib/rides/settings";
import { cancelFeeCents, freeCancelUntil, cashToCollectCents } from "@/lib/rides/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Câmpurile cursei vizibile părților (fără PI Stripe, token intern etc.). */
function publicRide(ride: RideRow, role: string) {
  return {
    id: ride.id,
    status: ride.status,
    city: ride.city,
    vehicle_class: ride.vehicle_class,
    pickup_address: ride.pickup_address,
    pickup_lat: ride.pickup_lat,
    pickup_lng: ride.pickup_lng,
    dropoff_address: ride.dropoff_address,
    dropoff_lat: ride.dropoff_lat,
    dropoff_lng: ride.dropoff_lng,
    estimated_fare_cents: ride.estimated_fare_cents,
    final_fare_cents: ride.final_fare_cents,
    currency: ride.currency,
    distance_km: ride.distance_km,
    duration_min: ride.duration_min,
    surge_multiplier: ride.surge_multiplier,
    payment_method: ride.payment_method,
    payment_status: ride.payment_status,
    authorized_amount_cents: ride.authorized_amount_cents,
    tip_cents: ride.tip_cents,
    cancel_reason: ride.cancel_reason,
    cancelled_by: ride.cancelled_by,
    cancel_fee_cents: ride.cancel_fee_cents,
    cancel_fee_status: ride.cancel_fee_status,
    requested_at: ride.requested_at,
    accepted_at: ride.accepted_at,
    arrived_at: ride.arrived_at,
    started_at: ride.started_at,
    completed_at: ride.completed_at,
    cancelled_at: ride.cancelled_at,
    share_token: role === "rider" || role === "admin" ? ride.share_token : null,
    cash_to_collect_cents: cashToCollectCents(ride),
  };
}

export const GET = withErrorHandling(async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuidParam(id)) return invalidIdResponse();
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ride = await loadRide(id);
  if (!ride) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const authUser = await getAuthUser().catch(() => null);
  const role = await resolveRole(ride, session.userId, Boolean(authUser?.isAdmin));
  if (!role) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let driver: Record<string, unknown> | null = null;
  if (ride.driver_id) {
    const { rows } = await dbQuery(
      `SELECT full_name, vehicle_type, vehicle_make, vehicle_model, vehicle_color,
              vehicle_plate, rating, phone, current_lat, current_lng, location_updated_at
         FROM couriers WHERE id = $1`,
      [ride.driver_id],
    );
    driver = rows[0] ?? null;
    // Riderul vede telefonul doar cât cursa e activă.
    if (driver && role === "rider" && !["accepted", "arriving", "in_progress"].includes(ride.status)) {
      delete driver.phone;
    }
    // Poziția șoferului doar cât cursa e activă (audit food-go #9): după final
    // pasagerul nu mai vede unde se află șoferul.
    if (driver && role !== "admin" && !["accepted", "arriving", "in_progress"].includes(ride.status)) {
      driver.current_lat = null;
      driver.current_lng = null;
      driver.location_updated_at = null;
    }
  }

  const { rows: ratings } = await dbQuery(`SELECT rater_role, stars, comment FROM ride_ratings WHERE ride_id = $1`, [id]);

  const settings = await getGoSettings();
  const { rows: zoneRows } = ride.pricing_zone_id
    ? await dbQuery<{ cancel_fee_cents: number }>(`SELECT cancel_fee_cents FROM pricing_zones WHERE id = $1`, [
        ride.pricing_zone_id,
      ])
    : { rows: [] as { cancel_fee_cents: number }[] };
  const until = freeCancelUntil(ride.accepted_at, settings.free_cancel_grace_seconds);
  const cancel_policy = {
    fee_cents_now: cancelFeeCents({
      acceptedAt: ride.accepted_at,
      zoneCancelFeeCents: zoneRows[0]?.cancel_fee_cents ?? 0,
      graceSeconds: settings.free_cancel_grace_seconds,
      cancelledBy: "rider",
    }),
    zone_fee_cents: zoneRows[0]?.cancel_fee_cents ?? 0,
    free_until: until ? until.toISOString() : null,
  };

  return NextResponse.json({ ride: publicRide(ride, role), driver, ratings, role, cancel_policy });
});
