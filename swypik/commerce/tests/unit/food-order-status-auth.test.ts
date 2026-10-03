import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sellerId: null as string | null,
  userId: null as string | null,
  courierId: null as string | null,
  transition: vi.fn(),
  effects: vi.fn(),
  capture: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock("@/lib/security/seller-auth", () => ({
  getSellerSessionId: async () => h.sellerId,
}));
vi.mock("@/lib/auth/session", () => ({
  getAuthSession: async () => h.userId ? { userId: h.userId, role: "shopper" } : null,
}));
vi.mock("@/lib/db", () => ({
  dbQuery: h.dbQuery,
}));
vi.mock("@/lib/food/transition", () => ({
  transitionOrder: h.transition,
}));
vi.mock("@/lib/food/transition-effects", () => ({
  runTransitionEffects: h.effects,
}));
vi.mock("@/lib/food/card-payment", () => ({
  captureLocalOrderPayment: h.capture,
}));

import { PATCH } from "@/app/api/local-orders/[id]/status/route";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function patch(status: string): Request {
  return new Request("https://swypik.com/api/local-orders/x/status", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeEach(() => {
  h.sellerId = null;
  h.userId = null;
  h.courierId = null;
  h.transition.mockReset();
  h.effects.mockReset();
  h.capture.mockReset();
  h.dbQuery.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM couriers WHERE user_id")) {
      return {
        rows: h.courierId ? [{ id: h.courierId }] : [],
        rowCount: h.courierId ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  });
});

describe("Food order status authorization", () => {
  it("returns 401 when the requester is neither a seller nor an approved courier", async () => {
    const res = await PATCH(patch("accepted"), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: "unauthorized",
      code: "unauthorized",
    });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it("returns 403 when a valid courier attempts a merchant-only transition", async () => {
    h.userId = "22222222-2222-4222-8222-222222222222";
    h.courierId = "33333333-3333-4333-8333-333333333333";
    const res = await PATCH(patch("accepted"), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    expect(res.status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it("returns 403 when a seller attempts a courier-only transition", async () => {
    h.sellerId = "44444444-4444-4444-8444-444444444444";
    const res = await PATCH(patch("picked_up"), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    expect(res.status).toBe(403);
    expect(h.transition).not.toHaveBeenCalled();
  });
});
