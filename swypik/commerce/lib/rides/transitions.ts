/**
 * Swypik Go — tranzițiile cursei, folosite de rutele rider/driver, consola
 * admin și cron-uri (o singură implementare, testată).
 *
 *   advanceRide:  accepted → arriving → in_progress (șofer/admin)
 *   completeRide: in_progress → completed (tarif final plafonat, capture, decont)
 *   cancelRide:   cine poate anula din ce stare + taxa (policy) + plata
 */
import { dbQuery, withTransaction, type TxQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { releaseJobForRide } from "@/lib/dispatch/lifecycle";
import { settleRide } from "@/lib/payments/mobility";
import { captureRidePayment } from "@/lib/payments/mobility-stripe";
import type { RideStatus } from "@/lib/validation/rides";
import { computeFinalFare, publishRideEvent, type RideRow } from "./service";
import { cancelFeeCents } from "./policy";
import { getGoSettings } from "./settings";
import { applyCancellationPayment } from "./cancel-fee";
import { shareExpirySql } from "@/lib/rides/share";

const log = logger.child({ mod: "rides-transitions" });

export type CancelActor = "rider" | "driver" | "admin" | "system";

export type TransitionResult =
  | { ok: true; status: RideStatus; [k: string]: unknown }
  | { ok: false; error: string; code: number };

/** Din ce stări poate anula fiecare actor. */
export const CANCELLABLE_FROM: Record<CancelActor, readonly RideStatus[]> = {
  rider: ["requested", "searching", "accepted", "arriving"],
  driver: ["accepted", "arriving"],
  admin: ["requested", "searching", "accepted", "arriving", "in_progress"],
  system: ["requested", "searching"],
};

async function lockRide(q: TxQuery, id: string): Promise<RideRow | null> {
  const { rows } = await q<RideRow>(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

async function zoneCancelFee(ride: RideRow): Promise<number> {
  const { rows } = await dbQuery<{ cancel_fee_cents: number }>(
    `SELECT cancel_fee_cents FROM pricing_zones WHERE id = $1`,
    [ride.pricing_zone_id],
  );
  return rows[0]?.cancel_fee_cents ?? 0;
}

export async function cancelRide(args: {
  rideId: string;
  actor: CancelActor;
  reason?: string | null;
}): Promise<TransitionResult> {
  const settings = await getGoSettings();
  const result = await withTransaction<TransitionResult & { ride?: RideRow }>(async (q) => {
    const ride = await lockRide(q, args.rideId);
    if (!ride) return { ok: false, error: "not_found", code: 404 };
    if (!CANCELLABLE_FROM[args.actor].includes(ride.status)) {
      return { ok: false, error: "bad_state", code: 409 };
    }
    const fee = cancelFeeCents({
      acceptedAt: ride.accepted_at,
      zoneCancelFeeCents: ride.pricing_zone_id ? await zoneCancelFee(ride) : 0,
      graceSeconds: settings.free_cancel_grace_seconds,
      cancelledBy: args.actor,
    });
    await q(
      `UPDATE rides
          SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
              cancel_reason = $2, cancelled_by = $3, cancel_fee_cents = $4,
              share_expires_at = ${shareExpirySql()}
        WHERE id = $1`,
      [ride.id, args.reason ?? null, args.actor === "rider" || args.actor === "driver" ? args.actor : "system", fee],
    );
    await releaseJobForRide(q, ride.id, "cancelled");
    return { ok: true, status: "cancelled", cancel_fee_cents: fee, ride };
  });
  if (!result.ok) return result;

  const fee = Number(result.cancel_fee_cents ?? 0);
  const outcome = await applyCancellationPayment(args.rideId, fee);
  if (result.ride) {
    await publishRideEvent(result.ride, {
      type: "status",
      status: "cancelled",
      ride_id: args.rideId,
      cancelled_by: args.actor,
      cancel_fee_cents: fee,
    });
  }
  log.info({ rideId: args.rideId, actor: args.actor, fee, outcome }, "ride cancelled");
  return { ok: true, status: "cancelled", cancel_fee_cents: fee, fee_outcome: outcome };
}

/** accepted → arriving → in_progress. */
export async function advanceRide(rideId: string, to: "arriving" | "in_progress"): Promise<TransitionResult> {
  const from: RideStatus = to === "arriving" ? "accepted" : "arriving";
  const column = to === "arriving" ? "arrived_at" : "started_at";
  const { rows } = await dbQuery<RideRow>(
    `UPDATE rides SET status = $2, ${column} = now(), updated_at = now()
      WHERE id = $1 AND status = $3
      RETURNING *`,
    [rideId, to, from],
  );
  if (!rows[0]) return { ok: false, error: "bad_state", code: 409 };
  await publishRideEvent(rows[0], { type: "status", status: to, ride_id: rideId });
  return { ok: true, status: to };
}

/** in_progress → completed: tarif final (GPS, plafonat), eliberare job, capture + decont. */
export async function completeRide(rideId: string): Promise<TransitionResult> {
  const settings = await getGoSettings();
  const result = await withTransaction<TransitionResult & { ride?: RideRow }>(async (q) => {
    const ride = await lockRide(q, rideId);
    if (!ride) return { ok: false, error: "not_found", code: 404 };
    if (ride.status !== "in_progress") return { ok: false, error: "bad_state", code: 409 };
    const fare = await computeFinalFare(ride, settings.fare_overrun_cap_bps);
    await q(
      `UPDATE rides
          SET status = 'completed', completed_at = now(), updated_at = now(),
              final_fare_cents = $2, distance_km = $3, duration_min = $4,
              fare_breakdown = $5, share_expires_at = ${shareExpirySql()}
        WHERE id = $1`,
      [rideId, fare.final_fare_cents, fare.distance_km, fare.duration_min, JSON.stringify(fare.breakdown)],
    );
    if (ride.driver_id) {
      await q(`UPDATE couriers SET completed_deliveries = completed_deliveries + 1, updated_at = now() WHERE id = $1`, [
        ride.driver_id,
      ]);
    }
    await releaseJobForRide(q, rideId, "completed");
    return {
      ok: true,
      status: "completed",
      final_fare_cents: fare.final_fare_cents,
      distance_km: fare.distance_km,
      duration_min: fare.duration_min,
      distance_source: fare.distance_source,
      ride,
    };
  });
  if (!result.ok) return result;

  try {
    await captureRidePayment(rideId);
  } catch (err) {
    log.error({ err, rideId }, "capture ride payment failed (settlement continues)");
  }
  try {
    await settleRide(rideId);
  } catch (err) {
    log.error({ err, rideId }, "settle ride failed");
  }
  const { ride, ...payload } = result;
  if (ride) await publishRideEvent(ride, { type: "status", ride_id: rideId, ...payload });
  return payload;
}
