import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  session: { userId: "u-1" } as { userId: string } | null,
  startDispatch: vi.fn(async () => ({ job_id: "job-1", offered: 1 })),
  owed: false,
  settings: { card_enabled: true, cash_enabled: true, free_cancel_grace_seconds: 120, fare_overrun_cap_bps: 2000 },
  activeRideRows: [] as unknown[],
  courier: { id: "c-1", kind: "driver", verification_status: "approved" } as Record<string, unknown> | null,
  job: null as unknown,
  rateRide: null as unknown,
  txSql: [] as string[],
  insertError: null as null | { code: string },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => h.session }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.2.3.4",
}));
vi.mock("@/lib/rides/city", () => ({
  resolveRideZone: async () => ({ id: "z-1", city: "București" }),
  NoZoneError: class extends Error {},
}));
vi.mock("@/lib/pricing/engine", () => ({
  estimate: async () => ({
    zone_id: "z-1",
    total_cents: 2000,
    currency: "RON",
    distance_km: 5,
    duration_min: 12,
    breakdown: { surge_multiplier: 1 },
  }),
}));
vi.mock("@/lib/rides/dispatch-start", () => ({ startRideDispatch: h.startDispatch }));
vi.mock("@/lib/rides/settings", () => ({ getGoSettings: async () => h.settings }));
vi.mock("@/lib/rides/cancel-fee", () => ({ riderHasOwedFees: async () => h.owed }));
vi.mock("@/lib/payments/mobility-stripe", () => ({ stripeConfigured: () => true }));
vi.mock("@/lib/rides/driver-job", () => ({
  getCourierForUser: async () => h.courier,
  getDriverActiveJob: async () => h.job,
  getRideToRate: async () => h.rateRide,
}));
vi.mock("@/lib/db", () => {
  const run = async (sql: string) => {
    if (sql.includes("status NOT IN ('completed','cancelled')")) return { rows: h.activeRideRows, rowCount: 0 };
    if (sql.includes("INSERT INTO rides")) {
      if (h.insertError) throw h.insertError;
      return { rows: [{ id: "r-new" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    dbQuery: vi.fn(run),
    withTransaction: vi.fn(async (fn: (q: (sql: string) => unknown) => unknown) =>
      fn(async (sql: string) => {
        h.txSql.push(sql);
        return run(sql);
      }),
    ),
  };
});

import { POST as createRide } from "@/app/api/rides/route";
import { GET as activeJob } from "@/app/api/couriers/active-job/route";

const body = (payment_method: string) =>
  new Request("http://localhost/api/rides", {
    method: "POST",
    body: JSON.stringify({
      pickup: { address: "Piața Unirii", lat: 44.42, lng: 26.1 },
      dropoff: { address: "Gara de Nord", lat: 44.44, lng: 26.07 },
      vehicle_class: "economy",
      payment_method,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u-1" };
  h.owed = false;
  h.settings = { ...h.settings, cash_enabled: true };
  h.activeRideRows = [];
  h.courier = { id: "c-1", kind: "driver", verification_status: "approved" };
  h.job = null;
  h.rateRide = null;
  h.txSql = [];
  h.insertError = null;
});

describe("POST /api/rides", () => {
  it("card ride is created 'requested' and NOT dispatched until authorized", async () => {
    const res = await createRide(body("card"));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ride_id: "r-new", status: "requested", requires_payment: true });
    expect(h.startDispatch).not.toHaveBeenCalled();
  });

  it("cash ride dispatches immediately when cash is enabled", async () => {
    const res = await createRide(body("cash"));
    expect(await res.json()).toMatchObject({ status: "searching", requires_payment: false });
    expect(h.startDispatch).toHaveBeenCalledWith("r-new");
  });

  it("refuses cash when disabled or when a cancel fee is owed", async () => {
    h.settings = { ...h.settings, cash_enabled: false };
    expect((await createRide(body("cash"))).status).toBe(422);
    h.settings = { ...h.settings, cash_enabled: true };
    h.owed = true;
    const res = await createRide(body("cash"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "payment_method_unavailable", allowed: ["card"] });
  });

  it("returns the active ride on conflict and requires login", async () => {
    h.activeRideRows = [{ id: "r-old" }];
    const res = await createRide(body("card"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "active_ride", ride_id: "r-old" });
    h.session = null;
    expect((await createRide(body("card"))).status).toBe(401);
  });
});

describe("POST /api/rides — one active ride, atomically (audit #13)", () => {
  it("serialises creation per rider with an advisory lock inside the insert transaction", async () => {
    const res = await createRide(body("card"));
    expect(res.status).toBe(201);
    expect(h.txSql[0]).toContain("pg_advisory_xact_lock");
    expect(h.txSql.some((s) => s.includes("INSERT INTO rides"))).toBe(true);
  });

  it("maps a unique-index violation (double tap) to 409 active_ride", async () => {
    h.insertError = { code: "23505" };
    const res = await createRide(body("card"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "active_ride" });
  });
});

describe("GET /api/couriers/active-job (reload recovery)", () => {
  it("restores the driver's active ride from the server", async () => {
    h.job = { kind: "ride", ride_id: "r-1", status: "arriving", cash_to_collect_cents: 0 };
    const res = await activeJob();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: h.job, rate_ride: null });
  });

  it("returns null when idle and 403 for non-couriers", async () => {
    expect(await (await activeJob()).json()).toEqual({ job: null, rate_ride: null });
    h.rateRide = { ride_id: "r-9", rider_first_name: "Ana", completed_at: "2026-09-28T10:00:00Z" };
    expect(await (await activeJob()).json()).toEqual({ job: null, rate_ride: h.rateRide });
    h.courier = null;
    expect((await activeJob()).status).toBe(403);
  });
});
