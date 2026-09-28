/**
 * Pornirea dispatch-ului pentru o cursă — O SINGURĂ poartă:
 *  - cash: imediat după creare;
 *  - card: doar după ce hold-ul e verificat la Stripe (payment_status='authorized').
 * Idempotent: createJob refolosește jobul activ; update-ul e gardat pe 'requested'.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createJob } from "@/lib/dispatch/engine";
import { markRideAuthorized } from "@/lib/payments/mobility-stripe";
import { loadRide } from "./service";

const log = logger.child({ mod: "rides-dispatch-start" });

export function canStartDispatch(ride: { status: string; payment_method: string; payment_status: string }): boolean {
  if (ride.status !== "requested") return false;
  if (ride.payment_method === "card") return ride.payment_status === "authorized";
  return ride.payment_method === "cash";
}

export async function startRideDispatch(rideId: string): Promise<{ job_id: string; offered: number } | null> {
  const ride = await loadRide(rideId);
  if (!ride || !canStartDispatch(ride)) return null;

  const { job, offered } = await createJob({
    kind: "ride",
    rideId,
    city: ride.city,
    pickupLat: ride.pickup_lat,
    pickupLng: ride.pickup_lng,
  });
  await dbQuery(
    `UPDATE rides SET job_id = $2, status = 'searching', updated_at = now() WHERE id = $1 AND status = 'requested'`,
    [rideId, job.id],
  );
  log.info({ rideId, jobId: job.id, offered }, "ride dispatch started");
  return { job_id: job.id, offered };
}

/**
 * Card confirmat (client după confirmPayment sau webhook): verificare Stripe →
 * 'authorized' → dispatch. Idempotent și sigur la apeluri concurente.
 */
export async function confirmCardAndDispatch(rideId: string): Promise<{ status: string }> {
  await markRideAuthorized(rideId);
  const started = await startRideDispatch(rideId);
  if (started) return { status: "searching" };
  const ride = await loadRide(rideId);
  return { status: ride?.status ?? "requested" };
}
