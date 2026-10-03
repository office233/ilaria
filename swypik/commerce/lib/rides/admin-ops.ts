/**
 * Consola de dispatch Swypik Go (/admin/go) — citiri live + atribuire manuală.
 * Anularea forțată folosește cancelRide({ actor: "admin" }) (fără taxă).
 */
import { dbQuery, withTransaction } from "@/lib/db";
import { publishJobEvent } from "@/lib/dispatch/engine";
import { COURIER_AVAILABLE_SQL } from "@/lib/dispatch/lifecycle";
import { documentsValidSql, requiredDocumentsFor } from "@/lib/fleet/documents";
import { canStartDispatch } from "./dispatch-start";
import type { RideRow } from "./service";

export type OnlineDriver = {
  id: string;
  full_name: string;
  kind: string;
  city: string;
  vehicle_plate: string | null;
  current_lat: number | null;
  current_lng: number | null;
  last_seen_at: string | null;
  busy: boolean;
};

export type LiveRide = {
  id: string;
  status: string;
  city: string;
  vehicle_class: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number;
  pickup_lng: number;
  payment_method: string;
  payment_status: string;
  estimated_fare_cents: number | null;
  currency: string;
  requested_at: string;
  driver_id: string | null;
  driver_name: string | null;
};

export type OwedFee = { id: string; cancel_fee_cents: number; currency: string; cancelled_at: string; pickup_address: string };

export async function getGoOverview(): Promise<{
  drivers: OnlineDriver[];
  rides: LiveRide[];
  owed_fees: OwedFee[];
  stats: { completed_today: number; cancelled_today: number; fees_owed: number; unpaid_issues: number };
}> {
  const [drivers, rides, stats, owed] = await Promise.all([
    dbQuery<OnlineDriver>(
      `SELECT c.id, c.full_name, c.kind, c.city, c.vehicle_plate, c.current_lat, c.current_lng,
              COALESCE(c.last_heartbeat_at, c.location_updated_at)::text AS last_seen_at,
              EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.assigned_courier_id = c.id AND j.status = 'assigned') AS busy
         FROM couriers c
        WHERE c.is_online AND ${COURIER_AVAILABLE_SQL}
        ORDER BY c.city, c.full_name
        LIMIT 500`,
    ),
    dbQuery<LiveRide>(
      `SELECT r.id, r.status, r.city, r.vehicle_class, r.pickup_address, r.dropoff_address,
              r.pickup_lat, r.pickup_lng, r.payment_method, r.payment_status, r.estimated_fare_cents,
              trim(r.currency) AS currency, r.requested_at::text, r.driver_id, c.full_name AS driver_name
         FROM rides r
         LEFT JOIN couriers c ON c.id = r.driver_id
        WHERE r.status NOT IN ('completed', 'cancelled')
        ORDER BY r.requested_at DESC
        LIMIT 200`,
    ),
    dbQuery<{ completed_today: number; cancelled_today: number; fees_owed: number; unpaid_issues: number }>(
      `SELECT
         (SELECT count(*)::int FROM rides WHERE status = 'completed' AND completed_at >= date_trunc('day', now())) AS completed_today,
         (SELECT count(*)::int FROM rides WHERE status = 'cancelled' AND cancelled_at >= date_trunc('day', now())) AS cancelled_today,
         (SELECT count(*)::int FROM rides WHERE cancel_fee_status = 'owed') AS fees_owed,
         (SELECT count(*)::int FROM reconciliation_issues WHERE kind = 'unpaid_completed_ride' AND NOT resolved) AS unpaid_issues`,
    ),
    dbQuery<OwedFee>(
      `SELECT id, cancel_fee_cents, trim(currency) AS currency, cancelled_at::text, pickup_address
         FROM rides WHERE cancel_fee_status = 'owed'
        ORDER BY cancelled_at DESC LIMIT 50`,
    ),
  ]);
  return {
    drivers: drivers.rows,
    rides: rides.rows,
    owed_fees: owed.rows,
    stats: stats.rows[0] ?? { completed_today: 0, cancelled_today: 0, fees_owed: 0, unpaid_issues: 0 },
  };
}

export type AssignResult =
  | { ok: true; job_id: string; previous_driver_id: string | null }
  | { ok: false; error: string; code: number };

/**
 * Atribuire / reatribuire manuală. Cursa trebuie să poată pleca la dispatch
 * (card autorizat sau cash); șoferul: aprobat, activ, cu heartbeat, liber.
 * La reatribuire cursa revine în 'accepted' (grația de anulare repornește).
 */
export async function adminAssignRide(rideId: string, courierId: string): Promise<AssignResult> {
  const requiredDocs = await requiredDocumentsFor("driver");
  const result = await withTransaction<AssignResult>(async (q) => {
    const { rows: rideRows } = await q<RideRow>(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId]);
    const ride = rideRows[0];
    if (!ride) return { ok: false, error: "not_found", code: 404 };
    const assignable = ["searching", "accepted", "arriving"].includes(ride.status) || canStartDispatch(ride);
    if (!assignable) {
      const unpaid = ride.status === "requested" && ride.payment_method === "card";
      return { ok: false, error: unpaid ? "payment_not_authorized" : "bad_state", code: 409 };
    }
    if (ride.driver_id === courierId) return { ok: false, error: "same_driver", code: 409 };

    const { rows: cRows } = await q<{ id: string }>(
      `SELECT c.id FROM couriers c
        WHERE c.id = $1 AND c.kind = 'driver' AND c.verification_status = 'approved' AND ${COURIER_AVAILABLE_SQL}
          AND ${documentsValidSql("$2")}
        FOR UPDATE`,
      [courierId, requiredDocs],
    );
    if (!cRows[0]) return { ok: false, error: "driver_unavailable", code: 409 };
    const { rows: busy } = await q(
      `SELECT 1 FROM dispatch_jobs WHERE assigned_courier_id = $1 AND status = 'assigned' AND ride_id IS DISTINCT FROM $2`,
      [courierId, rideId],
    );
    if (busy.length) return { ok: false, error: "driver_busy", code: 409 };

    const { rows: jobs } = await q<{ id: string }>(
      `SELECT id FROM dispatch_jobs WHERE ride_id = $1 AND status IN ('searching', 'assigned') FOR UPDATE`,
      [rideId],
    );
    let jobId = jobs[0]?.id;
    if (jobId) {
      await q(
        `UPDATE dispatch_jobs SET status = 'assigned', assigned_courier_id = $2, assigned_at = now(), updated_at = now()
          WHERE id = $1`,
        [jobId, courierId],
      );
      await q(`UPDATE dispatch_offers SET response = 'expired', responded_at = now() WHERE job_id = $1 AND response IS NULL`, [
        jobId,
      ]);
    } else {
      const { rows: created } = await q<{ id: string }>(
        `INSERT INTO dispatch_jobs (kind, ride_id, city, pickup_lat, pickup_lng, status, assigned_courier_id, assigned_at)
         VALUES ('ride', $1, $2, $3, $4, 'assigned', $5, now()) RETURNING id`,
        [rideId, ride.city, ride.pickup_lat, ride.pickup_lng, courierId],
      );
      jobId = created[0].id;
    }
    await q(
      `UPDATE rides SET driver_id = $2, job_id = $3, status = 'accepted', accepted_at = now(),
              arrived_at = NULL, updated_at = now()
        WHERE id = $1`,
      [rideId, courierId, jobId],
    );
    return { ok: true, job_id: jobId, previous_driver_id: ride.driver_id };
  });
  if (result.ok) {
    await publishJobEvent(result.job_id, { type: "status", status: "assigned", courier_id: courierId, ride_id: rideId });
  }
  return result;
}

/** Iertarea unei taxe de anulare datorate (deblochează cash-ul pasagerului). */
export async function waiveCancelFee(rideId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE rides SET cancel_fee_status = 'waived', updated_at = now()
      WHERE id = $1 AND cancel_fee_status = 'owed' RETURNING id`,
    [rideId],
  );
  return rows.length > 0;
}
