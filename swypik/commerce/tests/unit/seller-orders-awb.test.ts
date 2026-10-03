import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks reused across GET/POST — kept minimal, mirroring seller-squad.test.ts style.
const dbQueryMock = vi.fn();
const getSellerSessionIdMock = vi.fn(async (): Promise<string | null> => "seller-1");
const sendCustomerShippingAlertMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@/lib/db", () => ({
  dbQuery: (...args: unknown[]) => dbQueryMock(...args),
}));

vi.mock("@/lib/security/seller-auth", () => ({
  getSellerSessionId: () => getSellerSessionIdMock(),
}));

vi.mock("@/lib/email/service", () => ({
  sendCustomerShippingAlert: (...args: unknown[]) => sendCustomerShippingAlertMock(...args),
}));

import { GET, POST } from "@/app/api/seller/orders/[id]/awb/route";

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("Seller AWB API — stable error codes", () => {
  beforeEach(() => {
    dbQueryMock.mockReset();
    getSellerSessionIdMock.mockReset();
    getSellerSessionIdMock.mockResolvedValue("seller-1");
    sendCustomerShippingAlertMock.mockClear();
  });

  it("GET returns error:'unauthorized' (not a raw sentence) when there is no seller session", async () => {
    getSellerSessionIdMock.mockResolvedValueOnce(null);
    const req = new Request("http://localhost/api/seller/orders/order-1/awb");
    const res = await GET(req, makeParams("order-1"));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.error).toBe("unauthorized");
  });

  it("GET returns error:'not_found' when the order has no rows for this seller", async () => {
    dbQueryMock.mockResolvedValueOnce({ rows: [] });
    const req = new Request("http://localhost/api/seller/orders/order-1/awb");
    const res = await GET(req, makeParams("order-1"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("not_found");
  });

  it("POST returns error:'awb_number_required' when no manual tracking number is supplied", async () => {
    // checkOrder query: order exists, seller owns it, status is 'paid'.
    dbQueryMock.mockResolvedValueOnce({ rows: [{ status: "paid", metadata: {} }] });

    const req = new Request("http://localhost/api/seller/orders/order-1/awb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courier: "fancourier", parcels_count: 1, weight_kg: 1 }),
    });
    const res = await POST(req, makeParams("order-1"));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error).toBe("awb_number_required");
    // Swypik never fabricates AWB numbers — no DB write should happen past the check query.
    expect(dbQueryMock).toHaveBeenCalledTimes(1);
  });

  it("POST returns error:'invalid_status' for orders in a final state", async () => {
    dbQueryMock.mockResolvedValueOnce({ rows: [{ status: "refunded", metadata: {} }] });

    const req = new Request("http://localhost/api/seller/orders/order-1/awb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courier: "fancourier", manual_tracking_number: "1FC123456" }),
    });
    const res = await POST(req, makeParams("order-1"));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe("invalid_status");
  });

  it("POST returns error:'not_found' (not the Romanian sentence) when the seller does not own the order", async () => {
    dbQueryMock.mockResolvedValueOnce({ rows: [] });

    const req = new Request("http://localhost/api/seller/orders/order-1/awb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courier: "fancourier", manual_tracking_number: "1FC123456" }),
    });
    const res = await POST(req, makeParams("order-1"));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("not_found");
  });
});
