import { describe, it, expect, vi, beforeEach } from "vitest";

const { stripe, ride, dbQuery, createJob } = vi.hoisted(() => {
  const ride: Record<string, unknown> = {};
  return {
    ride,
    stripe: {
      paymentIntents: {
        create: vi.fn(),
        retrieve: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      },
    },
    createJob: vi.fn(async () => ({ job: { id: "job-1" }, offered: 2 })),
    dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM rides WHERE id")) return { rows: [{ ...ride }] };
      if (sql.includes("SET payment_status = 'authorized'")) {
        if (ride.status === "requested" && ride.payment_status === "unpaid") {
          ride.payment_status = "authorized";
          return { rows: [{ id: ride.id }] };
        }
        return { rows: [] };
      }
      if (sql.includes("SET job_id")) {
        ride.status = "searching";
        return { rows: [] };
      }
      if (sql.includes("SET payment_status = 'captured', cancel_fee_status = 'charged'")) {
        ride.payment_status = "captured";
        ride.cancel_fee_status = "charged";
      } else if (sql.includes("SET payment_status = 'captured'")) ride.payment_status = "captured";
      if (sql.includes("SET payment_intent_id")) {
        ride.payment_intent_id = params[1];
        ride.authorized_amount_cents = params[2];
      }
      return { rows: [] };
    }),
  };
});

vi.mock("@/lib/stripe/checkout", () => ({ getStripe: () => stripe }));
vi.mock("@/lib/db", () => ({ dbQuery, withTransaction: vi.fn() }));
vi.mock("@/lib/dispatch/engine", () => ({ createJob, publishJobEvent: vi.fn() }));

import {
  authorizeRidePayment,
  captureCancelFee,
  captureRidePayment,
  markRideAuthorized,
  RidePaymentError,
} from "@/lib/payments/mobility-stripe";
import { confirmCardAndDispatch, startRideDispatch } from "@/lib/rides/dispatch-start";

function resetRide(patch: Record<string, unknown> = {}) {
  for (const k of Object.keys(ride)) delete ride[k];
  Object.assign(ride, {
    id: "r-1",
    status: "requested",
    city: "București",
    pickup_lat: 44.4,
    pickup_lng: 26.1,
    payment_method: "card",
    payment_status: "unpaid",
    payment_intent_id: null,
    authorized_amount_cents: null,
    estimated_fare_cents: 2000,
    final_fare_cents: null,
    tip_cents: 0,
    currency: "RON",
    rider_user_id: "u-1",
    ...patch,
  });
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_x";
  vi.clearAllMocks();
  resetRide();
});

describe("card authorization before dispatch", () => {
  it("creates a manual-capture PaymentIntent on the fare cap and does NOT mark it authorized", async () => {
    stripe.paymentIntents.create.mockResolvedValue({ id: "pi_1", client_secret: "sec", amount: 2400 });
    const r = await authorizeRidePayment("r-1", 2000);
    expect(r).toEqual({ payment_intent_id: "pi_1", client_secret: "sec", amount_cents: 2400 });
    const [args] = stripe.paymentIntents.create.mock.calls[0];
    expect(args).toMatchObject({ amount: 2400, capture_method: "manual", metadata: { kind: "ride", ride_id: "r-1" } });
    expect(ride.payment_status).toBe("unpaid");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("refuses cash rides and rides past 'requested'", async () => {
    resetRide({ payment_method: "cash" });
    await expect(authorizeRidePayment("r-1", 2000)).rejects.toMatchObject({ code: "not_card" });
    resetRide({ status: "searching" });
    await expect(authorizeRidePayment("r-1", 2000)).rejects.toBeInstanceOf(RidePaymentError);
  });

  it("never dispatches an unauthorized card ride", async () => {
    expect(await startRideDispatch("r-1")).toBeNull();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects confirmation when Stripe does not hold the funds", async () => {
    resetRide({ payment_intent_id: "pi_1" });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method", metadata: { ride_id: "r-1" } });
    await expect(markRideAuthorized("r-1")).rejects.toMatchObject({ code: "payment_not_authorized" });
    expect(ride.payment_status).toBe("unpaid");
  });

  it("authorizes on requires_capture and then starts dispatch (idempotent)", async () => {
    resetRide({ payment_intent_id: "pi_1" });
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_capture",
      amount: 2400,
      amount_capturable: 2400,
      metadata: { ride_id: "r-1" },
    });
    expect(await confirmCardAndDispatch("r-1")).toEqual({ status: "searching" });
    expect(ride.payment_status).toBe("authorized");
    expect(createJob).toHaveBeenCalledTimes(1);
    // retry (client + webhook): no second job
    expect(await confirmCardAndDispatch("r-1")).toEqual({ status: "searching" });
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("releases the hold if the authorization lands on an already-cancelled ride", async () => {
    resetRide({ payment_intent_id: "pi_1", status: "cancelled" });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount: 2400, metadata: { ride_id: "r-1" } });
    await expect(markRideAuthorized("r-1")).rejects.toMatchObject({ code: "bad_state" });
    expect(stripe.paymentIntents.cancel).toHaveBeenCalled();
  });
});

describe("capture", () => {
  it("captures final fare + tip, capped at the capturable amount", async () => {
    resetRide({ status: "completed", payment_status: "authorized", payment_intent_id: "pi_1", final_fare_cents: 5000, tip_cents: 200 });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount: 2400, amount_capturable: 2400 });
    stripe.paymentIntents.capture.mockResolvedValue({ amount_received: 2400 });
    expect(await captureRidePayment("r-1")).toEqual({ captured_cents: 2400 });
    expect(stripe.paymentIntents.capture.mock.calls[0][1]).toEqual({ amount_to_capture: 2400 });
    expect(ride.payment_status).toBe("captured");
  });

  it("captures only the cancel fee from the hold", async () => {
    resetRide({ status: "cancelled", payment_status: "authorized", payment_intent_id: "pi_1" });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture", amount: 2400, amount_capturable: 2400 });
    stripe.paymentIntents.capture.mockResolvedValue({ amount_received: 700 });
    expect(await captureCancelFee("r-1", 700)).toBe(true);
    expect(stripe.paymentIntents.capture.mock.calls[0][1]).toEqual({ amount_to_capture: 700 });
    expect(ride.cancel_fee_status).toBe("charged");
  });

  it("does not capture a fee without an authorized hold", async () => {
    resetRide({ status: "cancelled", payment_status: "unpaid", payment_intent_id: "pi_1" });
    expect(await captureCancelFee("r-1", 700)).toBe(false);
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });
});
