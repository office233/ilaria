/**
 * Stripe pentru curse (Swypik Go) — capture manual.
 *
 * Flux (audit go.md P0 „card rides never authorized"):
 *  1. POST /api/rides (card) → cursa 'requested', FĂRĂ dispatch.
 *  2. authorizeRidePayment → PaymentIntent capture_method=manual pe plafonul
 *     tarifului (estimare + go_settings.fare_overrun_cap_bps) + bacșiș;
 *     clientul confirmă în Payment Element (3DS inclus).
 *  3. syncRideAuthorization (clientul după confirm + webhook-ul
 *     amount_capturable_updated) → verifică la Stripe `requires_capture`,
 *     marchează 'authorized' și ABIA ATUNCI pornește dispatch-ul.
 *  4. captureRidePayment la 'completed' (final + bacșiș ≤ suma autorizată);
 *     captureCancelFee la anulare cu taxă; cancelRideAuthorization altfel.
 *
 * Idempotent: chei Stripe ride:{id}:… + gărzi pe rides.payment_status.
 */
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/checkout";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { authorizationAmountCents } from "@/lib/rides/policy";

const log = logger.child({ mod: "payments/mobility-stripe" });

export class RidePaymentError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "RidePaymentError";
  }
}

type RidePayRow = {
  id: string;
  status: string;
  payment_method: string;
  payment_status: string;
  payment_intent_id: string | null;
  authorized_amount_cents: number | null;
  estimated_fare_cents: number | null;
  final_fare_cents: number | null;
  tip_cents: number;
  currency: string;
  rider_user_id: string;
};

async function loadRidePay(rideId: string): Promise<RidePayRow | null> {
  const { rows } = await dbQuery<RidePayRow>(
    `SELECT id, status, payment_method, payment_status, payment_intent_id, authorized_amount_cents,
            estimated_fare_cents, final_fare_cents, COALESCE(tip_cents,0)::int AS tip_cents,
            trim(currency) AS currency, rider_user_id
       FROM rides WHERE id = $1`,
    [rideId],
  );
  return rows[0] ?? null;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

const REUSABLE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation", "requires_action"];

/**
 * Creează (sau refolosește) pre-autorizarea pentru o cursă card 'requested'.
 * NU marchează 'authorized' — asta se întâmplă doar după verificarea la Stripe.
 */
export async function authorizeRidePayment(
  rideId: string,
  capBps: number,
): Promise<{ payment_intent_id: string; client_secret: string; amount_cents: number }> {
  const ride = await loadRidePay(rideId);
  if (!ride) throw new RidePaymentError("not_found", 404);
  if (ride.payment_method !== "card") throw new RidePaymentError("not_card");
  if (ride.status !== "requested" || ride.payment_status !== "unpaid") throw new RidePaymentError("bad_state");
  if (!stripeConfigured()) throw new RidePaymentError("card_unavailable", 503);
  const base = ride.estimated_fare_cents ?? 0;
  if (base <= 0) throw new RidePaymentError("no_estimate");

  const amount = authorizationAmountCents(base, ride.tip_cents, capBps);
  const stripe = getStripe();

  if (ride.payment_intent_id) {
    const pi = await stripe.paymentIntents.retrieve(ride.payment_intent_id).catch(() => null);
    if (pi && REUSABLE.includes(pi.status) && pi.amount === amount && pi.client_secret) {
      return { payment_intent_id: pi.id, client_secret: pi.client_secret, amount_cents: amount };
    }
  }

  const pi = await stripe.paymentIntents.create(
    {
      amount,
      currency: (ride.currency || "ron").toLowerCase(),
      capture_method: "manual",
      payment_method_types: ["card"],
      metadata: { kind: "ride", ride_id: ride.id, rider_user_id: ride.rider_user_id },
      description: `Swypik Go ride ${ride.id}`,
    },
    { idempotencyKey: `ride:${ride.id}:authorize:${amount}` },
  );
  if (!pi.client_secret) throw new RidePaymentError("payment_failed", 502);

  await dbQuery(
    `UPDATE rides SET payment_intent_id = $2, authorized_amount_cents = $3, updated_at = now() WHERE id = $1`,
    [ride.id, pi.id, amount],
  );
  log.info({ rideId, pi: pi.id, amount }, "ride payment intent created (awaiting confirmation)");
  return { payment_intent_id: pi.id, client_secret: pi.client_secret, amount_cents: amount };
}

/**
 * Verifică la Stripe că hold-ul există (requires_capture) și marchează cursa
 * 'authorized'. Returnează true DOAR la tranziția unpaid→authorized (caller-ul
 * pornește atunci dispatch-ul). Autorizare venită pe o cursă deja anulată →
 * hold-ul e eliberat imediat.
 */
export async function markRideAuthorized(rideId: string): Promise<{ authorized: boolean; status: string }> {
  const ride = await loadRidePay(rideId);
  if (!ride?.payment_intent_id) throw new RidePaymentError("payment_not_authorized");
  if (ride.payment_status === "authorized") return { authorized: false, status: ride.status };

  const pi = await getStripe().paymentIntents.retrieve(ride.payment_intent_id);
  if (pi.metadata?.ride_id !== ride.id || pi.status !== "requires_capture") {
    throw new RidePaymentError("payment_not_authorized");
  }
  if (ride.status !== "requested") {
    await cancelRideAuthorization(rideId);
    throw new RidePaymentError("bad_state");
  }
  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE rides
        SET payment_status = 'authorized', payment_authorized_at = now(),
            authorized_amount_cents = $2, updated_at = now()
      WHERE id = $1 AND status = 'requested' AND payment_status = 'unpaid'
      RETURNING id`,
    [rideId, pi.amount_capturable || pi.amount],
  );
  return { authorized: rows.length > 0, status: ride.status };
}

async function capture(rideId: string, piId: string, cents: number, key: string): Promise<number | null> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (pi.status === "succeeded") return pi.amount_received;
  if (pi.status !== "requires_capture") {
    log.warn({ rideId, piStatus: pi.status }, "capture skipped — PI not capturable");
    return null;
  }
  const toCapture = Math.min(Math.max(cents, 1), pi.amount_capturable || pi.amount);
  const captured = await stripe.paymentIntents.capture(pi.id, { amount_to_capture: toCapture }, { idempotencyKey: key });
  return captured.amount_received ?? toCapture;
}

/** Capture la completed: final + bacșiș, plafonat la suma autorizată. Idempotent. */
export async function captureRidePayment(rideId: string): Promise<{ captured_cents: number } | null> {
  const ride = await loadRidePay(rideId);
  if (!ride || ride.payment_method !== "card" || !ride.payment_intent_id) return null;
  if (ride.payment_status === "captured") return { captured_cents: ride.final_fare_cents ?? 0 };

  const wanted = (ride.final_fare_cents ?? ride.estimated_fare_cents ?? 0) + ride.tip_cents;
  const got = await capture(rideId, ride.payment_intent_id, wanted, `ride:${ride.id}:capture`);
  if (got == null) {
    await dbQuery(`UPDATE rides SET payment_status = 'failed', updated_at = now() WHERE id = $1`, [rideId]);
    return null;
  }
  await dbQuery(`UPDATE rides SET payment_status = 'captured', updated_at = now() WHERE id = $1`, [rideId]);
  log.info({ rideId, captured: got }, "ride payment captured");
  return { captured_cents: got };
}

/** Taxa de anulare: capture parțial din hold. false = nu s-a putut (hold lipsă/expirat). */
export async function captureCancelFee(rideId: string, feeCents: number): Promise<boolean> {
  const ride = await loadRidePay(rideId);
  if (!ride?.payment_intent_id || ride.payment_status !== "authorized" || feeCents <= 0) return false;
  try {
    const got = await capture(rideId, ride.payment_intent_id, feeCents, `ride:${ride.id}:cancel_fee`);
    if (got == null) return false;
    await dbQuery(
      `UPDATE rides SET payment_status = 'captured', cancel_fee_status = 'charged', updated_at = now() WHERE id = $1`,
      [rideId],
    );
    return true;
  } catch (err) {
    log.error({ err, rideId }, "cancel fee capture failed");
    return false;
  }
}

/** Eliberează pre-autorizarea (no-op dacă nu există PI activ). */
export async function cancelRideAuthorization(rideId: string): Promise<void> {
  const ride = await loadRidePay(rideId);
  if (!ride?.payment_intent_id || !["unpaid", "authorized"].includes(ride.payment_status)) return;
  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(ride.payment_intent_id);
    if (pi.status !== "canceled" && pi.status !== "succeeded") {
      await stripe.paymentIntents.cancel(pi.id, undefined, { idempotencyKey: `ride:${ride.id}:cancel` });
    }
    await dbQuery(`UPDATE rides SET payment_status = 'unpaid', updated_at = now() WHERE id = $1`, [rideId]);
  } catch (err) {
    log.warn({ rideId, err }, "cancel authorization failed (may already be canceled)");
  }
}
