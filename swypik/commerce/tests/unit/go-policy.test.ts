import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(), withTransaction: vi.fn() }));
vi.mock("@/lib/dispatch/engine", () => ({ publishJobEvent: vi.fn() }));

import {
  allowedPaymentMethods,
  authorizationAmountCents,
  cancelFeeCents,
  capFinalFare,
  cashToCollectCents,
  freeCancelUntil,
  maxFareCents,
} from "@/lib/rides/policy";
import { canTransition } from "@/lib/rides/service";
import { computeFare } from "@/lib/pricing/engine";

const accepted = "2026-09-26T10:00:00.000Z";
const at = (sec: number) => Date.parse(accepted) + sec * 1000;

describe("cancel fee policy", () => {
  it("is free before a driver accepted", () => {
    expect(cancelFeeCents({ acceptedAt: null, zoneCancelFeeCents: 700, graceSeconds: 120, cancelledBy: "rider" })).toBe(0);
  });
  it("is free inside the grace window and charged after it", () => {
    const base = { acceptedAt: accepted, zoneCancelFeeCents: 700, graceSeconds: 120, cancelledBy: "rider" as const };
    expect(cancelFeeCents({ ...base, now: at(120) })).toBe(0);
    expect(cancelFeeCents({ ...base, now: at(121) })).toBe(700);
  });
  it("never charges when the driver, admin or system cancels", () => {
    for (const who of ["driver", "admin", "system"] as const) {
      expect(cancelFeeCents({ acceptedAt: accepted, zoneCancelFeeCents: 700, graceSeconds: 0, cancelledBy: who, now: at(999) })).toBe(0);
    }
  });
  it("exposes the free-until moment", () => {
    expect(freeCancelUntil(accepted, 120)?.toISOString()).toBe("2026-09-26T10:02:00.000Z");
    expect(freeCancelUntil(null, 120)).toBeNull();
  });
});

describe("fare cap + authorization amount", () => {
  it("caps the GPS fare at estimate + cap", () => {
    expect(maxFareCents(1000, 2000)).toBe(1200);
    expect(capFinalFare(1500, 1000, 2000)).toEqual({ final_cents: 1200, capped: true });
    expect(capFinalFare(900, 1000, 2000)).toEqual({ final_cents: 900, capped: false });
    expect(capFinalFare(1500, null, 2000)).toEqual({ final_cents: 1500, capped: false });
  });
  it("authorizes exactly the cap plus tip, so capture can never exceed the hold", () => {
    const auth = authorizationAmountCents(1000, 300, 2000);
    expect(auth).toBe(1500);
    expect(capFinalFare(99_999, 1000, 2000).final_cents + 300).toBeLessThanOrEqual(auth);
  });
});

describe("payment methods", () => {
  const on = { card_enabled: true, cash_enabled: true };
  it("offers card only when Stripe is configured", () => {
    expect(allowedPaymentMethods(on, { stripeConfigured: false, hasOwedFees: false })).toEqual(["cash"]);
    expect(allowedPaymentMethods(on, { stripeConfigured: true, hasOwedFees: false })).toEqual(["card", "cash"]);
  });
  it("offers cash only when enabled and no cancel fee is owed", () => {
    expect(allowedPaymentMethods({ card_enabled: true, cash_enabled: false }, { stripeConfigured: true, hasOwedFees: false })).toEqual(["card"]);
    expect(allowedPaymentMethods(on, { stripeConfigured: true, hasOwedFees: true })).toEqual(["card"]);
  });
  it("computes the cash to collect (fare + tip, card = 0)", () => {
    expect(cashToCollectCents({ payment_method: "cash", final_fare_cents: 2500, estimated_fare_cents: 2000, tip_cents: 500 })).toBe(3000);
    expect(cashToCollectCents({ payment_method: "cash", final_fare_cents: null, estimated_fare_cents: 2000 })).toBe(2000);
    expect(cashToCollectCents({ payment_method: "card", final_fare_cents: 2500, estimated_fare_cents: 2000 })).toBe(0);
  });
});

describe("ride state machine", () => {
  it("lets only the driver advance accepted → arriving → in_progress → completed", () => {
    expect(canTransition("accepted", "arriving", "driver")).toEqual({ ok: true });
    expect(canTransition("arriving", "in_progress", "driver")).toEqual({ ok: true });
    expect(canTransition("in_progress", "completed", "driver")).toEqual({ ok: true });
    expect(canTransition("accepted", "arriving", "rider")).toMatchObject({ ok: false, code: 403 });
  });
  it("rejects skipped or unknown transitions", () => {
    expect(canTransition("accepted", "completed", "driver")).toMatchObject({ ok: false, code: 409 });
    expect(canTransition("searching", "arriving", "admin")).toMatchObject({ ok: false, code: 409 });
    expect(canTransition("accepted", "teleported", "driver")).toMatchObject({ ok: false, code: 400 });
  });
});

describe("pricing formula", () => {
  const zone = { base_cents: 300, per_km_cents: 260, per_min_cents: 40, min_fare_cents: 1000, booking_fee_cents: 150 };
  it("computes base + km + min, surge, then booking fee (integer cents)", () => {
    const f = computeFare(zone, 5, 10, 1.0);
    expect(f.total_cents).toBe(300 + 1300 + 400 + 150);
    expect(f.min_fare_applied).toBe(false);
    expect(computeFare(zone, 5, 10, 1.5).total_cents).toBe(Math.round(2000 * 1.5) + 150);
  });
  it("applies the minimum fare before the booking fee", () => {
    const f = computeFare(zone, 0.5, 1, 1.0);
    expect(f.min_fare_applied).toBe(true);
    expect(f.total_cents).toBe(1000 + 150);
  });
});
