import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { sql: string; params: unknown[] };
const { dbCalls, txCalls, state } = vi.hoisted(() => ({
  dbCalls: [] as Call[],
  txCalls: [] as Call[],
  state: { courierActive: true, releasedIds: ["job-1"], staleIds: [] as string[] },
}));

function txQuery(sql: string, params: unknown[] = []) {
  txCalls.push({ sql, params });
  if (sql.includes("FROM dispatch_jobs") && sql.includes("FOR UPDATE")) {
    return Promise.resolve({ rows: [{ id: "job-1", status: "searching", assigned_courier_id: null, order_id: null, ride_id: null }], rowCount: 1 });
  }
  if (sql.includes("FROM dispatch_offers") && sql.includes("FOR UPDATE")) {
    return Promise.resolve({ rows: [{ id: "offer-1" }], rowCount: 1 });
  }
  if (sql.includes("SELECT active FROM couriers")) {
    return Promise.resolve({ rows: [{ active: state.courierActive }], rowCount: 1 });
  }
  if (sql.includes("UPDATE dispatch_jobs SET status = $2")) {
    return Promise.resolve({ rows: state.releasedIds.map((id) => ({ id })), rowCount: state.releasedIds.length });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    dbCalls.push({ sql, params });
    if (sql.includes("UPDATE couriers c SET is_online = false")) {
      return { rows: state.staleIds.map((id) => ({ id })), rowCount: state.staleIds.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(async (fn: (q: typeof txQuery) => unknown) => fn(txQuery)),
}));
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ publish: async () => 1 }) }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: async () => undefined }));

import { releaseJobForOrder, releaseJobForRide, sweepStaleCouriers, COURIER_AVAILABLE_SQL } from "@/lib/dispatch/lifecycle";
import { acceptOffer, tick } from "@/lib/dispatch/engine";
import type { TxQuery } from "@/lib/db";

beforeEach(() => {
  dbCalls.length = 0;
  txCalls.length = 0;
  state.courierActive = true;
  state.releasedIds = ["job-1"];
  state.staleIds = [];
});

describe("job release", () => {
  it("completes the active job of a delivered order and expires its pending offers", async () => {
    const ids = await releaseJobForOrder(txQuery as unknown as TxQuery, "order-1", "completed");
    expect(ids).toEqual(["job-1"]);
    expect(txCalls[0].sql).toContain("WHERE order_id = $1 AND status IN ('searching', 'assigned')");
    expect(txCalls[0].params).toEqual(["order-1", "completed"]);
    expect(txCalls[1].sql).toContain("response = 'expired'");
    expect(txCalls[1].params).toEqual([["job-1"]]);
  });

  it("cancels the active job of a cancelled ride; no offer update when nothing was released", async () => {
    state.releasedIds = [];
    await releaseJobForRide(txQuery as unknown as TxQuery, "ride-1", "cancelled");
    expect(txCalls[0].sql).toContain("WHERE ride_id = $1");
    expect(txCalls[0].params).toEqual(["ride-1", "cancelled"]);
    expect(txCalls).toHaveLength(1);
  });
});

describe("stale courier sweep", () => {
  it("sets offline couriers that are suspended or have no fresh heartbeat and expires their offers", async () => {
    state.staleIds = ["c-1", "c-2"];
    const n = await sweepStaleCouriers();
    expect(n).toBe(2);
    expect(dbCalls[0].sql).toContain("NOT (c.active AND COALESCE(COALESCE(c.last_heartbeat_at, c.location_updated_at)");
    expect(dbCalls[1].params).toEqual([["c-1", "c-2"]]);
  });

  it("runs as the first step of the dispatch tick", async () => {
    state.staleIds = ["c-9"];
    const r = await tick();
    expect(r.staleCouriers).toBe(1);
    expect(dbCalls[0].sql).toContain("UPDATE couriers c SET is_online = false");
  });

  it("availability predicate requires active + heartbeat freshness", () => {
    expect(COURIER_AVAILABLE_SQL).toContain("c.active");
    expect(COURIER_AVAILABLE_SQL).toContain("make_interval(secs => 120)");
  });
});

describe("acceptOffer", () => {
  it("refuses a suspended courier", async () => {
    state.courierActive = false;
    const r = await acceptOffer("job-1", "courier-1");
    expect(r).toEqual({ ok: false, error: "Courier account suspended.", code: 403 });
    expect(txCalls.some((c) => c.sql.includes("SET status = 'assigned'"))).toBe(false);
  });

  it("assigns an active courier", async () => {
    const r = await acceptOffer("job-1", "courier-1");
    expect(r.ok).toBe(true);
  });
});
