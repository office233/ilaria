import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 2026-09-24 (wave2-misc): POST/PATCH/DELETE
 * /api/merchants/[id]/menu had auth + ownership checks but no rate limiting,
 * unlike sibling seller-mutation routes. Now gated with the
 * lib/security/rate-limit.ts pattern (prefix "sellerMenu").
 */

let sellerId: string | null = "seller-1";
vi.mock("@/lib/security/seller-auth", () => ({
  getSellerSessionId: async () => sellerId,
}));

let rlSuccess = true;
const rateLimitMock = vi.fn(async (_prefix: string, _identifier: string) => ({
  success: rlSuccess,
  remaining: rlSuccess ? 10 : 0,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: (prefix: string, identifier: string) => rateLimitMock(prefix, identifier),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const dbQueryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("FROM local_merchants")) return { rows: [{ 1: 1 }], rowCount: 1 };
  return { rows: [{ id: "item-1", name: "Test", price_cents: 1000, is_available: true }], rowCount: 1 };
});
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => dbQueryMock(sql, params),
  withTransaction: async (fn: (q: unknown) => Promise<unknown>) =>
    fn(async () => ({ rows: [], rowCount: 1 })),
}));

import { POST, PATCH, DELETE } from "@/app/api/merchants/[id]/menu/route";

const params = Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" });

function jsonReq(method: string, body?: Record<string, unknown>, search = ""): Request {
  return new Request(`http://localhost/api/merchants/x/menu${search}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  sellerId = "seller-1";
  rlSuccess = true;
  rateLimitMock.mockClear();
  dbQueryMock.mockClear();
});

describe("Merchant menu mutating routes — rate limiting", () => {
  it("POST returns 429 when rate-limited, without hitting the DB insert", async () => {
    rlSuccess = false;
    const res = await POST(
      jsonReq("POST", { name: "Cola", price: 9.9, currency: "RON" }),
      { params },
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toEqual({ success: false, error: "rate_limited", code: "rate_limited" });
  });

  it("POST proceeds when under the limit", async () => {
    const res = await POST(
      jsonReq("POST", { name: "Cola", price: 9.9, currency: "RON" }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(rateLimitMock).toHaveBeenCalledWith("sellerMenu", "seller-1");
  });

  it("PATCH returns 429 when rate-limited", async () => {
    rlSuccess = false;
    const res = await PATCH(
      jsonReq("PATCH", { item_id: "22222222-2222-4222-8222-222222222222", name: "Renamed item" }),
      { params },
    );
    expect(res.status).toBe(429);
  });

  it("DELETE returns 429 when rate-limited", async () => {
    rlSuccess = false;
    const res = await DELETE(jsonReq("DELETE", undefined, "?item_id=22222222-2222-4222-8222-222222222222"), { params });
    expect(res.status).toBe(429);
  });
});
