/**
 * Taxa de anulare — încasare + decontare (audit go.md P0 „cancel fee never charged").
 *
 *  - card cu hold: capture parțial pe taxă → șoferul primește cota lui din
 *    taxă în wallet ledger, platforma restul (comision). Idempotent pe ride id.
 *  - cash (sau hold indisponibil): taxa rămâne DATORATĂ (cancel_fee_status=
 *    'owed'); pasagerul nu mai poate alege cash până la reglare (policy).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { creditUser } from "@/lib/wallet/ledger";
import { computeSplit } from "@/lib/pricing/split";
import { recordCommission } from "@/lib/payments/platform-account";
import { captureCancelFee, cancelRideAuthorization } from "@/lib/payments/mobility-stripe";
import { MOBILITY_PLATFORM_FEE_BPS, MOBILITY_COURIER_SHARE_BPS } from "@/lib/config/commerce";

const log = logger.child({ mod: "rides-cancel-fee" });

type FeeRide = {
  id: string;
  payment_method: string;
  payment_status: string;
  driver_user_id: string | null;
  platform_commission_pct: string | null;
  courier_share_pct: string | null;
};

async function loadFeeRide(rideId: string): Promise<FeeRide | null> {
  const { rows } = await dbQuery<FeeRide>(
    `SELECT r.id, r.payment_method, r.payment_status, c.user_id AS driver_user_id,
            pz.platform_commission_pct, pz.courier_share_pct
       FROM rides r
       LEFT JOIN couriers c ON c.id = r.driver_id
       LEFT JOIN pricing_zones pz ON pz.id = r.pricing_zone_id
      WHERE r.id = $1`,
    [rideId],
  );
  return rows[0] ?? null;
}

/** Decontarea unei taxe încasate: cota șoferului + comisionul platformei. */
export async function settleCancelFee(rideId: string, feeCents: number): Promise<void> {
  const ride = await loadFeeRide(rideId);
  if (!ride || feeCents <= 0) return;
  const split = computeSplit({
    fee_cents: feeCents,
    platform_commission_pct: Number(ride.platform_commission_pct ?? MOBILITY_PLATFORM_FEE_BPS / 100),
    courier_share_pct: Number(ride.courier_share_pct ?? MOBILITY_COURIER_SHARE_BPS / 100),
  });
  if (ride.driver_user_id && split.courier_cents > 0) {
    await creditUser({
      userId: ride.driver_user_id,
      amountCents: split.courier_cents,
      refType: "ride_cancel_fee",
      refId: ride.id,
      description: `Taxă anulare cursă #${ride.id.slice(0, 8)}`,
      metadata: { split },
    });
  }
  // Fără șofer (n-ar trebui: taxa apare doar după accept) platforma ia tot.
  const platformCents = ride.driver_user_id ? split.platform_cents : feeCents;
  await recordCommission({
    refType: "commission_ride",
    refId: ride.id,
    amountCents: platformCents,
    description: `Comision taxă anulare #${ride.id.slice(0, 8)}`,
    metadata: { split, cancel_fee_cents: feeCents },
  });
}

/**
 * După commit-ul anulării: încasează taxa sau eliberează hold-ul.
 * Best-effort — eșecurile sunt logate, anularea rămâne valabilă.
 */
export async function applyCancellationPayment(rideId: string, feeCents: number): Promise<"charged" | "owed" | "released" | "none"> {
  const ride = await loadFeeRide(rideId);
  if (!ride) return "none";
  try {
    if (feeCents > 0) {
      if (ride.payment_method === "card" && (await captureCancelFee(rideId, feeCents))) {
        await settleCancelFee(rideId, feeCents);
        return "charged";
      }
      await dbQuery(`UPDATE rides SET cancel_fee_status = 'owed', updated_at = now() WHERE id = $1`, [rideId]);
      if (ride.payment_method === "card") await cancelRideAuthorization(rideId);
      return "owed";
    }
    if (ride.payment_method === "card") {
      await cancelRideAuthorization(rideId);
      return "released";
    }
    return "none";
  } catch (err) {
    log.error({ err, rideId, feeCents }, "cancellation payment handling failed");
    return "none";
  }
}

/** Pasagerul are taxe de anulare neachitate? (blochează cash-ul) */
export async function riderHasOwedFees(userId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM rides WHERE rider_user_id = $1 AND cancel_fee_status = 'owed'`,
    [userId],
  );
  return (rows[0]?.n ?? 0) > 0;
}
