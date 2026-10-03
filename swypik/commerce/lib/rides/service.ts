/**
 * Swypik Go — logica de domeniu pentru curse.
 *
 *  - loadRide / resolveRole: cine e cine pe o cursă (rider / driver / admin).
 *  - applyTransition: mașina de stări STRICTĂ + verificare rol per tranziție.
 *  - finalizeFare: la 'completed' recalculează tariful pe distanța REALĂ
 *    parcursă (GPS din courier_location_history între started_at și now),
 *    cu fallback pe estimare dacă traseul GPS e prea sărac (< 2 puncte).
 *
 * Dispatch-ul (căutare șofer, oferte, accept) e în lib/dispatch/engine.ts.
 * Pricing-ul (zone, surge, formulă) e în lib/pricing/engine.ts.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { publishJobEvent } from "@/lib/dispatch/engine";
import { findZone, computeFare } from "@/lib/pricing/engine";
import { capFinalFare } from "./policy";
import { haversineKm } from "@/lib/pricing/distance";
import type { RideStatus } from "@/lib/validation/rides";

const log = logger.child({ service: "rides" });

export type RideRow = {
  id: string;
  rider_user_id: string | null;
  driver_id: string | null;
  job_id: string | null;
  city: string;
  vehicle_class: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  status: RideStatus;
  estimated_fare_cents: number | null;
  final_fare_cents: number | null;
  currency: string;
  distance_km: string | null;
  duration_min: number | null;
  surge_multiplier: string;
  fare_breakdown: Record<string, unknown> | null;
  payment_method: string;
  payment_status: string;
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancel_fee_cents: number | null;
  cancel_fee_status: string;
  pricing_zone_id: string | null;
  payment_intent_id: string | null;
  authorized_amount_cents: number | null;
  tip_cents: number;
  share_token: string | null;
  requested_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

export async function loadRide(id: string): Promise<RideRow | null> {
  const { rows } = await dbQuery<RideRow>(`SELECT * FROM rides WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export type RideRole = "rider" | "driver" | "admin" | null;

/** Rolul userului logat față de cursă. Driver = couriers.user_id al șoferului atribuit. */
export async function resolveRole(
  ride: RideRow,
  userId: string,
  isAdmin: boolean,
): Promise<RideRole> {
  if (isAdmin) return "admin";
  if (ride.rider_user_id === userId) return "rider";
  if (ride.driver_id) {
    const { rows } = await dbQuery<{ id: string }>(
      `SELECT id FROM couriers WHERE id = $1 AND user_id = $2`,
      [ride.driver_id, userId],
    );
    if (rows.length) return "driver";
  }
  return null;
}

// ─── Mașina de stări ────────────────────────────────────────────────────────
// Cine are voie să facă fiecare tranziție:
//   driver: accepted → arriving → in_progress → completed
//   rider/driver: → cancelled (din requested|searching|accepted|arriving)
// 'accepted' se setează DOAR de dispatch engine (acceptOffer), nu prin PATCH.
const TRANSITIONS: Record<string, { from: RideStatus[]; roles: ("rider" | "driver")[] }> = {
  arriving: { from: ["accepted"], roles: ["driver"] },
  in_progress: { from: ["arriving"], roles: ["driver"] },
  completed: { from: ["in_progress"], roles: ["driver"] },
  cancelled: {
    from: ["requested", "searching", "accepted", "arriving"],
    roles: ["rider", "driver"],
  },
};

export function canTransition(
  from: RideStatus,
  to: string,
  role: RideRole,
): { ok: true } | { ok: false; error: string; code: number } {
  const t = TRANSITIONS[to];
  if (!t) return { ok: false, error: `Invalid status: ${to}`, code: 400 };
  if (!t.from.includes(from)) {
    return { ok: false, error: `Transition not allowed: ${from} → ${to}`, code: 409 };
  }
  if (role === "admin") return { ok: true };
  if (!role || !t.roles.includes(role)) {
    return { ok: false, error: "Your role cannot perform this transition.", code: 403 };
  }
  return { ok: true };
}

// ─── Recalculare tarif final pe distanța reală ─────────────────────────────
/**
 * Distanța reală parcursă = suma segmentelor haversine consecutive din
 * courier_location_history pentru șoferul cursei, între started_at și now.
 * Punctele aberante (salt > 2 km între ping-uri la ~10s) sunt ignorate.
 */
export async function actualDistanceKm(ride: RideRow): Promise<number | null> {
  if (!ride.driver_id || !ride.started_at) return null;
  const { rows } = await dbQuery<{ lat: number; lng: number }>(
    `SELECT lat, lng FROM courier_location_history
      WHERE courier_id = $1 AND recorded_at >= $2
      ORDER BY recorded_at ASC`,
    [ride.driver_id, ride.started_at],
  );
  if (rows.length < 2) return null;
  let km = 0;
  for (let i = 1; i < rows.length; i++) {
    const seg = haversineKm(rows[i - 1], rows[i]);
    if (seg > 2) continue; // GPS glitch — sărim segmentul
    km += seg;
  }
  return km > 0 ? km : null;
}

export type FinalFare = {
  final_fare_cents: number;
  distance_km: number;
  duration_min: number;
  breakdown: Record<string, unknown>;
  distance_source: "gps" | "estimate";
};

/**
 * Tariful final la 'completed': aceeași formulă și același surge ca la
 * estimare (surge-ul e ÎNGHEȚAT la cel de la request — corect față de client),
 * dar pe distanța reală GPS și durata reală started_at → now.
 * Fallback: dacă GPS-ul nu are destule puncte, rămâne tariful estimat.
 * Plafon: estimarea + capBps (go_settings.fare_overrun_cap_bps) — pasagerul
 * nu plătește niciodată peste plafonul autorizat pe card.
 */
export async function computeFinalFare(ride: RideRow, capBps: number): Promise<FinalFare> {
  const startedAt = ride.started_at ? new Date(ride.started_at) : new Date();
  const durationMin = Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60000));
  const gpsKm = await actualDistanceKm(ride);
  const surge = Number(ride.surge_multiplier) || 1.0;

  const zone = await findZone(ride.city, "ride", ride.vehicle_class);
  if (!zone || gpsKm == null) {
    // fără zonă sau fără traseu GPS → păstrăm estimarea
    return {
      final_fare_cents: ride.estimated_fare_cents ?? 0,
      distance_km: gpsKm ?? Number(ride.distance_km ?? 0),
      duration_min: durationMin,
      breakdown: {
        ...(ride.fare_breakdown ?? {}),
        distance_source: "estimate",
        final_duration_min: durationMin,
      },
      distance_source: "estimate",
    };
  }

  const fare = computeFare(zone, gpsKm, durationMin, surge);
  const capped = capFinalFare(fare.total_cents, ride.estimated_fare_cents, capBps);
  return {
    final_fare_cents: capped.final_cents,
    distance_km: Math.round(gpsKm * 1000) / 1000,
    duration_min: durationMin,
    breakdown: { ...fare, distance_source: "gps", capped: capped.capped, uncapped_total_cents: fare.total_cents },
    distance_source: "gps",
  };
}

/** Publish pe canalul SSE al jobului de dispatch (dacă există). */
export async function publishRideEvent(
  ride: RideRow,
  event: Record<string, unknown>,
): Promise<void> {
  if (!ride.job_id) return;
  try {
    await publishJobEvent(ride.job_id, event);
  } catch (err) {
    log.warn({ err, rideId: ride.id }, "publish ride event failed");
  }
}
