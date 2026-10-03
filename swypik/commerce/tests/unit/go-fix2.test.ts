/**
 * Audit food-go (fix2) — Go/dispatch: ordinea lock-urilor la accept, documente
 * la emiterea ofertelor, grația de heartbeat cu job activ, re-abonarea stream-ului
 * după autorizarea cardului, poziția șoferului ascunsă după final.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { sql: string; params: unknown[] };
const h = vi.hoisted(() => ({
  tx: [] as { sql: string; params: unknown[] }[],
  db: [] as { sql: string; params: unknown[] }[],
  peek: { ride_id: "r-1", order_id: null } as { ride_id: string | null; order_id: string | null },
  rideUpdated: true,
  couriers: [] as unknown[],
  track: null as Record<string, unknown> | null,
  ride: null as Record<string, unknown> | null,
  sse: null as null | { channels?: string[]; poll?: { intervalMs: number; run: (send: (d: unknown) => void) => Promise<void> } },
}));

function txQuery(sql: string, params: unknown[] = []) {
  h.tx.push({ sql, params });
  if (sql.includes("SELECT ride_id, order_id FROM dispatch_jobs")) return Promise.resolve({ rows: [h.peek], rowCount: 1 });
  if (sql.includes("FROM dispatch_jobs") && sql.includes("FOR UPDATE")) {
    return Promise.resolve({ rows: [{ id: "job-1", status: "searching", assigned_courier_id: null, order_id: h.peek.order_id, ride_id: h.peek.ride_id }], rowCount: 1 });
  }
  if (sql.includes("FROM dispatch_offers") && sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [{ id: "offer-1" }], rowCount: 1 });
  if (sql.includes("SELECT active FROM couriers")) return Promise.resolve({ rows: [{ active: true }], rowCount: 1 });
  if (sql.includes("UPDATE rides SET driver_id")) return Promise.resolve({ rows: h.rideUpdated ? [{ id: "r-1" }] : [], rowCount: h.rideUpdated ? 1 : 0 });
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.db.push({ sql, params });
    if (sql.includes("INSERT INTO dispatch_jobs")) {
      return { rows: [{ id: "job-9", kind: "ride", order_id: null, ride_id: "r-1", city: "Cluj", pickup_lat: 46.7, pickup_lng: 23.6, status: "searching", wave: 0 }], rowCount: 1 };
    }
    if (sql.includes("FROM couriers c") && sql.includes("distance_km")) return { rows: h.couriers, rowCount: 0 };
    if (sql.includes("FROM rides") && sql.includes("share_token = $1")) return { rows: h.track ? [h.track] : [], rowCount: 1 };
    if (sql.includes("SELECT full_name, current_lat, current_lng FROM couriers")) {
      return { rows: [{ full_name: "Ion Pop", current_lat: 46.7, current_lng: 23.6 }], rowCount: 1 };
    }
    if (sql.includes("SELECT full_name, vehicle_type")) {
      return { rows: [{ full_name: "Ion", phone: "+40", current_lat: 46.7, current_lng: 23.6, location_updated_at: "t" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(async (fn: (q: typeof txQuery) => unknown) => fn(txQuery)),
}));
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ publish: async () => 1 }) }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: async () => undefined }));
vi.mock("@/lib/rides/settings", () => ({
  getGoSettings: async () => ({ required_driver_documents: ["id_card", "rca_insurance"], free_cancel_grace_seconds: 120 }),
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }), getClientIP: () => "1.1.1.1" }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "u-1" }) }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => ({ isAdmin: false }) }));
vi.mock("@/lib/rides/service", () => ({
  loadRide: async () => h.ride,
  resolveRole: async () => "rider",
}));
vi.mock("@/lib/realtime/sse", () => ({
  createSseResponse: (opts: typeof h.sse) => {
    h.sse = opts;
    return new Response("stream");
  },
}));
vi.mock("@/lib/realtime", () => ({ realtimeChannels: { dispatchJob: (id: string) => `dispatch:job:${id}` } }));

import { acceptOffer, createJob } from "@/lib/dispatch/engine";
import { sweepStaleCouriers, COURIER_ON_ACTIVE_JOB_GRACE_SQL } from "@/lib/dispatch/lifecycle";
import { COURIER_ACTIVE_JOB_STALE_SECONDS } from "@/lib/dispatch/constants";
import { GET as trackGet } from "@/app/api/go/track/[token]/route";
import { GET as rideGet } from "@/app/api/rides/[id]/route";
import { GET as streamGet } from "@/app/api/rides/[id]/stream/route";

const RIDE = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(32);

beforeEach(() => {
  h.tx = [];
  h.db = [];
  h.peek = { ride_id: "r-1", order_id: null };
  h.rideUpdated = true;
  h.couriers = [];
  h.track = null;
  h.ride = null;
  h.sse = null;
});

describe("acceptOffer lock ordering (audit #12)", () => {
  it("locks the ride before the dispatch job (same order as cancelRide)", async () => {
    const r = await acceptOffer("job-1", "c-1");
    expect(r.ok).toBe(true);
    const rideLock = h.tx.findIndex((c: Call) => c.sql.includes("FROM rides WHERE id = $1 FOR UPDATE"));
    const jobLock = h.tx.findIndex((c: Call) => c.sql.includes("FROM dispatch_jobs") && c.sql.includes("FOR UPDATE"));
    expect(rideLock).toBeGreaterThanOrEqual(0);
    expect(rideLock).toBeLessThan(jobLock);
  });

  it("locks the order first for deliveries", async () => {
    h.peek = { ride_id: null, order_id: "o-1" };
    await acceptOffer("job-1", "c-1");
    const orderLock = h.tx.findIndex((c: Call) => c.sql.includes("FROM local_orders WHERE id = $1 FOR UPDATE"));
    const jobLock = h.tx.findIndex((c: Call) => c.sql.includes("FROM dispatch_jobs") && c.sql.includes("FOR UPDATE"));
    expect(orderLock).toBeLessThan(jobLock);
  });

  it("does not assign a ride cancelled in the meantime", async () => {
    h.rideUpdated = false;
    expect(await acceptOffer("job-1", "c-1")).toEqual({ ok: false, error: "Job already taken.", code: 409 });
  });
});

describe("offers only to drivers with valid documents (audit #2)", () => {
  it("passes the required documents and excludes deleted couriers", async () => {
    await createJob({ kind: "ride", rideId: "r-1", city: "Cluj", pickupLat: 46.7, pickupLng: 23.6 });
    const q = h.db.find((c: Call) => c.sql.includes("FROM couriers c") && c.sql.includes("distance_km"));
    expect(q?.sql).toContain("courier_documents");
    expect(q?.sql).toContain("expires_at >= current_date");
    expect(q?.sql).toContain("c.deleted_at IS NULL");
    expect(q?.params[6]).toBe("driver");
    expect(q?.params[7]).toEqual(["id_card", "rca_insurance"]);
  });
});

describe("heartbeat grace while on a job (audit #10)", () => {
  it("keeps couriers with an assigned job online for the extended grace", async () => {
    await sweepStaleCouriers();
    expect(h.db[0].sql).toContain(COURIER_ON_ACTIVE_JOB_GRACE_SQL);
    expect(COURIER_ON_ACTIVE_JOB_GRACE_SQL).toContain("status = 'assigned'");
    expect(COURIER_ACTIVE_JOB_STALE_SECONDS).toBe(900);
  });
});

describe("public track link (audit #9)", () => {
  const base = { pickup_address: "A", pickup_lat: 1, pickup_lng: 2, dropoff_address: "B", dropoff_lat: 3, dropoff_lng: 4, driver_id: "c-1" };

  it("shows the driver position only while the ride is active", async () => {
    h.track = { ...base, status: "in_progress" };
    let body = await (await trackGet(new Request("http://x"), { params: Promise.resolve({ token: TOKEN }) })).json();
    expect(body.driver.position).toEqual({ lat: 46.7, lng: 23.6 });

    h.track = { ...base, status: "completed" };
    body = await (await trackGet(new Request("http://x"), { params: Promise.resolve({ token: TOKEN }) })).json();
    expect(body.driver.position).toBeNull();
    const sql = h.db.find((c: Call) => c.sql.includes("share_token = $1"));
    expect(sql?.params[1]).toBe(15);
  });
});

describe("GET /api/rides/[id] hides the driver position after the ride (audit #9)", () => {
  const ride = { id: RIDE, driver_id: "c-1", job_id: "job-1", pricing_zone_id: null, accepted_at: null, tip_cents: 0, payment_method: "card", status: "completed" };

  it("nulls coordinates for a finished ride, keeps them for an active one", async () => {
    h.ride = ride;
    let body = await (await rideGet(new Request("http://x"), { params: Promise.resolve({ id: RIDE }) })).json();
    expect(body.driver.current_lat).toBeNull();
    h.ride = { ...ride, status: "arriving" };
    body = await (await rideGet(new Request("http://x"), { params: Promise.resolve({ id: RIDE }) })).json();
    expect(body.driver.current_lat).toBe(46.7);
  });
});

describe("ride stream re-subscribes once the dispatch job exists (audit #1)", () => {
  it("polls for the job while job_id is null and announces resubscribe", async () => {
    h.ride = { id: RIDE, job_id: null, status: "requested", driver_id: null };
    await streamGet(new Request("http://x"), { params: Promise.resolve({ id: RIDE }) });
    expect(h.sse?.channels).toEqual([]);
    expect(h.sse?.poll).toBeDefined();
    const send = vi.fn();
    await h.sse!.poll!.run(send);
    expect(send).not.toHaveBeenCalled();
    h.ride = { ...h.ride, job_id: "job-7", status: "searching" };
    await h.sse!.poll!.run(send);
    await h.sse!.poll!.run(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "resubscribe", status: "searching" });
  });

  it("subscribes directly to the job channel when it already exists", async () => {
    h.ride = { id: RIDE, job_id: "job-7", status: "searching", driver_id: null };
    await streamGet(new Request("http://x"), { params: Promise.resolve({ id: RIDE }) });
    expect(h.sse?.channels).toEqual(["dispatch:job:job-7"]);
    expect(h.sse?.poll).toBeUndefined();
  });
});
