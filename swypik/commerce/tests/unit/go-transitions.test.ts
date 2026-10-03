import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const ride: Record<string, unknown> = {};
  const updates: { sql: string; params: unknown[] }[] = [];
  const q = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FOR UPDATE")) return { rows: [{ ...ride }] };
    updates.push({ sql, params });
    return { rows: [] };
  });
  return {
    ride,
    updates,
    q,
    release: vi.fn(async () => ["job-1"]),
    applyPayment: vi.fn(async () => "charged"),
    capture: vi.fn(async () => ({ captured_cents: 1 })),
    settle: vi.fn(async () => null),
    publish: vi.fn(async () => undefined),
    finalFare: vi.fn(async () => ({
      final_fare_cents: 2400,
      distance_km: 9.1,
      duration_min: 20,
      breakdown: { capped: true },
      distance_source: "gps",
    })),
  };
});

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => (sql.includes("cancel_fee_cents FROM pricing_zones") ? { rows: [{ cancel_fee_cents: 700 }] } : { rows: [] })),
  withTransaction: vi.fn(async (fn: (q: typeof h.q) => unknown) => fn(h.q)),
}));
vi.mock("@/lib/dispatch/lifecycle", () => ({ releaseJobForRide: h.release }));
vi.mock("@/lib/payments/mobility", () => ({ settleRide: h.settle }));
vi.mock("@/lib/payments/mobility-stripe", () => ({ captureRidePayment: h.capture }));
vi.mock("@/lib/rides/cancel-fee", () => ({ applyCancellationPayment: h.applyPayment }));
vi.mock("@/lib/rides/service", () => ({ computeFinalFare: h.finalFare, publishRideEvent: h.publish }));
vi.mock("@/lib/rides/settings", () => ({
  getGoSettings: async () => ({ free_cancel_grace_seconds: 120, fare_overrun_cap_bps: 2000 }),
}));

import { cancelRide, completeRide, CANCELLABLE_FROM } from "@/lib/rides/transitions";

function setRide(patch: Record<string, unknown>) {
  for (const k of Object.keys(h.ride)) delete h.ride[k];
  Object.assign(h.ride, { id: "r-1", pricing_zone_id: "z-1", driver_id: "c-1", accepted_at: null, ...patch });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
});

describe("cancelRide", () => {
  it("rider cancelling after the grace window pays the zone fee (captured via the hold)", async () => {
    setRide({ status: "accepted", accepted_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    const r = await cancelRide({ rideId: "r-1", actor: "rider", reason: "changed_mind" });
    expect(r).toMatchObject({ ok: true, status: "cancelled", cancel_fee_cents: 700, fee_outcome: "charged" });
    expect(h.applyPayment).toHaveBeenCalledWith("r-1", 700);
    expect(h.release).toHaveBeenCalledWith(h.q, "r-1", "cancelled");
    const upd = h.updates.find((u) => u.sql.includes("status = 'cancelled'"));
    expect(upd?.params).toEqual(["r-1", "changed_mind", "rider", 700]);
  });

  it("is free inside the grace window", async () => {
    setRide({ status: "accepted", accepted_at: new Date().toISOString() });
    const r = await cancelRide({ rideId: "r-1", actor: "rider" });
    expect(r).toMatchObject({ ok: true, cancel_fee_cents: 0 });
    expect(h.applyPayment).toHaveBeenCalledWith("r-1", 0);
  });

  it("admin cancels in_progress without a fee, recorded as system", async () => {
    setRide({ status: "in_progress", accepted_at: new Date(Date.now() - 3_600_000).toISOString() });
    const r = await cancelRide({ rideId: "r-1", actor: "admin", reason: "admin_cancel" });
    expect(r).toMatchObject({ ok: true, cancel_fee_cents: 0 });
    const upd = h.updates.find((u) => u.sql.includes("status = 'cancelled'"));
    expect(upd?.params[2]).toBe("system");
  });

  it("refuses transitions not allowed for the actor", async () => {
    setRide({ status: "in_progress" });
    expect(await cancelRide({ rideId: "r-1", actor: "rider" })).toEqual({ ok: false, error: "bad_state", code: 409 });
    setRide({ status: "searching" });
    expect(await cancelRide({ rideId: "r-1", actor: "driver" })).toEqual({ ok: false, error: "bad_state", code: 409 });
    expect(h.applyPayment).not.toHaveBeenCalled();
    expect(CANCELLABLE_FROM.system).toEqual(["requested", "searching"]);
  });
});

describe("completeRide", () => {
  it("stores the capped final fare, releases the job, captures and settles", async () => {
    setRide({ status: "in_progress", estimated_fare_cents: 2000 });
    const r = await completeRide("r-1");
    expect(r).toMatchObject({ ok: true, status: "completed", final_fare_cents: 2400 });
    expect(h.finalFare).toHaveBeenCalledWith(expect.objectContaining({ id: "r-1" }), 2000);
    expect(h.release).toHaveBeenCalledWith(h.q, "r-1", "completed");
    expect(h.capture).toHaveBeenCalledWith("r-1");
    expect(h.settle).toHaveBeenCalledWith("r-1");
  });

  it("refuses to complete a ride that has not started", async () => {
    setRide({ status: "arriving" });
    expect(await completeRide("r-1")).toEqual({ ok: false, error: "bad_state", code: 409 });
    expect(h.capture).not.toHaveBeenCalled();
  });
});
