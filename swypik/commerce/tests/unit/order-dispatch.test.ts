import { describe, it, expect, vi, beforeEach } from "vitest";

const dbQuery = vi.fn();
const sendSellerNewOrderAlert = vi.fn();

vi.mock("@/lib/db", () => ({ dbQuery: (...a: unknown[]) => dbQuery(...a) }));
vi.mock("@/lib/email/service", () => ({
  sendSellerNewOrderAlert: (...a: unknown[]) => sendSellerNewOrderAlert(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

import { routeOrder, type OrderItem } from "@/lib/fulfillment/order-router";

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    productId: "p1",
    title: "Produs test",
    quantity: 1,
    price: 100,
    ...overrides,
  };
}

beforeEach(() => {
  dbQuery.mockReset();
  sendSellerNewOrderAlert.mockReset();
  dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("routeOrder (dispatch comenzi)", () => {
  it("routes items without seller_id to manual queue", async () => {
    const plan = await routeOrder("o1", [item()]);
    expect(plan.manual).toHaveLength(1);
    expect(Object.keys(plan.localSellers)).toHaveLength(0);
  });

  it("routes items with seller_id to localSellers, grouped by seller", async () => {
    const plan = await routeOrder("o1", [
      item({ metadata: { seller_id: "s1", source: "local" } }),
      item({ productId: "p2", metadata: { seller_id: "s1", source: "local" } }),
      item({ productId: "p3", metadata: { seller_id: "s2", source: "local" } }),
    ]);
    expect(plan.manual).toHaveLength(0);
    expect(Object.keys(plan.localSellers).sort()).toEqual(["s1", "s2"]);
    expect(plan.localSellers["s1"]).toHaveLength(2);
  });

  it("sets pending status for items without seller (manual processing)", async () => {
    await routeOrder("o1", [item()]);
    const updateCall = dbQuery.mock.calls.find((c) => String(c[0]).includes("commerce_order_items"));
    expect(updateCall).toBeDefined();
    expect(updateCall![1][0]).toBe("pending");
  });

  it("sets pending_seller_action + computes 10% commission for local items", async () => {
    await routeOrder("o1", [item({ price: 100, quantity: 2, metadata: { seller_id: "s1", source: "local" } })]);
    const updateCall = dbQuery.mock.calls.find((c) => String(c[0]).includes("commerce_order_items"));
    expect(updateCall![1][0]).toBe("pending_seller_action");
    const meta = JSON.parse(updateCall![1][3] as string);
    // 100 RON × 2 = 20000 cents → 10% = 2000 commission, 18000 payout
    expect(meta.swypik_commission_cents).toBe(2000);
    expect(meta.seller_payout_cents).toBe(18000);
  });

  it("builds external_line_item_id as pgId:sku", async () => {
    await routeOrder("o1", [item({ productId: "pg-77", skuId: "sku-1" })]);
    const updateCall = dbQuery.mock.calls.find((c) => String(c[0]).includes("commerce_order_items"));
    expect(updateCall![1]).toContain("pg-77:sku-1");
  });

  it("defaults sku to 'default' when missing", async () => {
    await routeOrder("o1", [item({ productId: "pg-77" })]);
    const updateCall = dbQuery.mock.calls.find((c) => String(c[0]).includes("commerce_order_items"));
    expect(updateCall![1]).toContain("pg-77:default");
  });

  it("emails each local seller exactly once", async () => {
    dbQuery.mockImplementation(async (q: string) => {
      if (String(q).includes("FROM sellers")) return { rows: [{ email: "seller@x.ro" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await routeOrder("o1", [
      item({ metadata: { seller_id: "s1", source: "local" } }),
      item({ productId: "p2", metadata: { seller_id: "s1", source: "local" } }),
    ]);
    expect(sendSellerNewOrderAlert).toHaveBeenCalledTimes(1);
    expect(sendSellerNewOrderAlert.mock.calls[0][0]).toBe("seller@x.ro");
  });

  it("does not email when the seller has no email", async () => {
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await routeOrder("o1", [item({ metadata: { seller_id: "s1", source: "local" } })]);
    expect(sendSellerNewOrderAlert).not.toHaveBeenCalled();
  });

  it("survives db errors on status updates and still returns the plan", async () => {
    dbQuery.mockRejectedValue(new Error("db down"));
    const plan = await routeOrder("o1", [item()]);
    expect(plan.manual).toHaveLength(1);
  });
});
