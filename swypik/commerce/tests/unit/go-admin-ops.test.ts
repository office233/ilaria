import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    ride: {} as Record<string, unknown>,
    driverOk: true,
    busy: false,
    job: null as { id: string } | null,
    writes: [] as string[],
  };
  const q = vi.fn(async (sql: string) => {
    if (sql.includes("FROM rides WHERE id")) return { rows: [{ ...state.ride }] };
    if (sql.includes("FROM couriers c")) return { rows: state.driverOk ? [{ id: "c-2" }] : [] };
    if (sql.includes("assigned_courier_id = $1 AND status = 'assigned'")) return { rows: state.busy ? [{ 1: 1 }] : [] };
    if (sql.includes("SELECT id FROM dispatch_jobs")) return { rows: state.job ? [state.job] : [] };
    if (sql.includes("INSERT INTO dispatch_jobs")) {
      state.writes.push("insert_job");
      return { rows: [{ id: "job-new" }] };
    }
    if (sql.startsWith("UPDATE")) state.writes.push(sql.split("\n")[0].trim());
    return { rows: [] };
  });
  return { state, q, publish: vi.fn(async () => undefined) };
});

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(), withTransaction: vi.fn(async (fn: (q: typeof h.q) => unknown) => fn(h.q)) }));
vi.mock("@/lib/dispatch/engine", () => ({ publishJobEvent: h.publish, createJob: vi.fn() }));
vi.mock("@/lib/payments/mobility-stripe", () => ({ markRideAuthorized: vi.fn() }));

import { adminAssignRide } from "@/lib/rides/admin-ops";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, {
    ride: { id: "r-1", status: "searching", payment_method: "card", payment_status: "authorized", driver_id: null, city: "București" },
    driverOk: true,
    busy: false,
    job: { id: "job-1" },
    writes: [],
  });
});

describe("adminAssignRide", () => {
  it("assigns a searching ride to a free driver and publishes the event", async () => {
    expect(await adminAssignRide("r-1", "c-2")).toEqual({ ok: true, job_id: "job-1", previous_driver_id: null });
    expect(h.state.writes.some((w) => w.startsWith("UPDATE rides SET driver_id"))).toBe(true);
    expect(h.publish).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "assigned", courier_id: "c-2" }));
  });

  it("creates a job when the ride has none (e.g. no_courier) and reports the previous driver on reassign", async () => {
    h.state.job = null;
    h.state.ride = { ...h.state.ride, status: "arriving", driver_id: "c-1" };
    expect(await adminAssignRide("r-1", "c-2")).toEqual({ ok: true, job_id: "job-new", previous_driver_id: "c-1" });
    expect(h.state.writes).toContain("insert_job");
  });

  it("never assigns an unauthorized card ride", async () => {
    h.state.ride = { ...h.state.ride, status: "requested", payment_status: "unpaid" };
    expect(await adminAssignRide("r-1", "c-2")).toEqual({ ok: false, error: "payment_not_authorized", code: 409 });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("refuses unavailable, busy or identical drivers", async () => {
    h.state.driverOk = false;
    expect(await adminAssignRide("r-1", "c-2")).toMatchObject({ ok: false, error: "driver_unavailable" });
    h.state.driverOk = true;
    h.state.busy = true;
    expect(await adminAssignRide("r-1", "c-2")).toMatchObject({ ok: false, error: "driver_busy" });
    h.state.ride = { ...h.state.ride, driver_id: "c-2", status: "accepted" };
    expect(await adminAssignRide("r-1", "c-2")).toMatchObject({ ok: false, error: "same_driver" });
  });
});
