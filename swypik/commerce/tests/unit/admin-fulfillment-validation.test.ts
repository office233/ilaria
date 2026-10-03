import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fulfill: vi.fn(),
  tracking: vi.fn(),
  cancel: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: vi.fn(),
}));
vi.mock("@/lib/admin/guard", () => ({
  requireAdmin: async () => ({
    id: "admin-1",
    userId: "11111111-1111-4111-8111-111111111111",
    email: "admin@example.com",
    role: "owner",
    permissions: ["commerce"],
  }),
}));
vi.mock("@/lib/suppliers/fulfillment", () => ({
  fulfillOrder: h.fulfill,
  updateOrderTracking: h.tracking,
  cancelOrder: h.cancel,
}));
vi.mock("@/lib/security/admin-audit", () => ({
  logAdminAction: h.audit,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/admin/fulfillment/route";

const ORDER = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return new Request("https://swypik.com/api/admin/fulfillment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.fulfill.mockReset().mockResolvedValue({ success: true, orderId: ORDER });
  h.tracking.mockReset().mockResolvedValue(true);
  h.cancel.mockReset().mockResolvedValue(true);
  h.audit.mockReset().mockResolvedValue(undefined);
});

describe("admin fulfillment input contract", () => {
  it("rejects a non-UUID order id before any fulfillment action", async () => {
    const res = await POST(req({ action: "fulfill", orderId: "order-1" }));
    expect(res.status).toBe(400);
    expect(h.fulfill).not.toHaveBeenCalled();
  });

  it("requires trackingNumber in the add_tracking variant", async () => {
    const res = await POST(req({ action: "add_tracking", orderId: ORDER }));
    expect(res.status).toBe(400);
    expect(h.tracking).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS tracking URLs and unknown fields", async () => {
    const http = await POST(req({
      action: "add_tracking",
      orderId: ORDER,
      trackingNumber: "AWB-1",
      trackingUrl: "http://tracking.example/order",
    }));
    expect(http.status).toBe(400);

    const extra = await POST(req({
      action: "cancel",
      orderId: ORDER,
      reason: "test",
      force: true,
    }));
    expect(extra.status).toBe(400);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("accepts a valid tracking update with normalized values", async () => {
    const res = await POST(req({
      action: "add_tracking",
      orderId: ORDER,
      trackingNumber: "  AWB-123  ",
      trackingUrl: "https://tracking.example/order/123",
    }));
    expect(res.status).toBe(200);
    expect(h.tracking).toHaveBeenCalledWith(
      ORDER,
      "AWB-123",
      "https://tracking.example/order/123",
    );
  });
});
