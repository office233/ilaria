import { describe, it, expect, vi, beforeEach } from "vitest";

const { release, state } = vi.hoisted(() => ({
  release: vi.fn(async () => ["job-1"]),
  state: { courierActive: true, orderStatus: "delivering" },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "u-1", role: "shopper" }) }));
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => null }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/dispatch/auto", () => ({ maybeAutoDispatch: async () => undefined }));
vi.mock("@/lib/dispatch/lifecycle", () => ({ releaseJobForOrder: release }));
vi.mock("@/lib/dispatch/engine", () => ({
  getJobForOrder: async () => null,
  publishJobEvent: async () => undefined,
}));
vi.mock("@/lib/payments/mobility", () => ({ settleLocalOrder: async () => undefined }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: async () => undefined }));

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

const q = vi.fn(async (sql: string) => {
  if (sql.includes("FROM local_orders lo JOIN local_merchants")) {
    return {
      rows: [{ id: "o-1", status: state.orderStatus, courier_id: "c-1", customer_user_id: null, seller_id: "s-1", merchant_name: "M" }],
      rowCount: 1,
    };
  }
  if (sql.includes("UPDATE local_orders")) return { rows: [{ id: "o-1", status: "delivered" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM couriers WHERE user_id")) return { rows: [{ id: "c-1" }], rowCount: 1 };
    if (sql.includes("UPDATE couriers")) {
      return { rows: [{ id: "c-1", is_online: state.courierActive, active: state.courierActive }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(async (fn: (qq: typeof q) => unknown) => fn(q)),
}));

import { PATCH as orderStatus } from "@/app/api/local-orders/[id]/status/route";
import { POST as courierStatus } from "@/app/api/couriers/status/route";

function patch(status: string): Request {
  return new Request("http://localhost/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeEach(() => {
  release.mockClear();
  q.mockClear();
  state.courierActive = true;
  state.orderStatus = "delivering";
});

describe("local order status → dispatch job release", () => {
  it("completes the dispatch job inside the delivery transaction", async () => {
    const res = await orderStatus(patch("delivered"), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(200);
    expect(release).toHaveBeenCalledWith(q, ORDER_ID, "completed");
  });

  it("rejects a non-UUID order id with 400 before touching the DB (audit #14)", async () => {
    const res = await orderStatus(patch("delivered"), { params: Promise.resolve({ id: "o-1" }) });
    expect(res.status).toBe(400);
    expect(q).not.toHaveBeenCalled();
  });
});

describe("courier heartbeat", () => {
  it("rejects a suspended courier and keeps them offline", async () => {
    state.courierActive = false;
    const res = await courierStatus(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ online: true, lat: 44.4, lng: 26.1 }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "courier_suspended", online: false });
  });

  it("accepts an active courier", async () => {
    const res = await courierStatus(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ online: false }) }));
    expect(res.status).toBe(200);
  });
});
