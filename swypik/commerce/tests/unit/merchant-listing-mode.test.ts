import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 2026-09-26 (w1-removals-data): profilurile nerevendicate (OSM) sunt
 * `listing_mode = 'suggest_only'` și nu pot primi comenzi; lista publică nu mai
 * expune rating-ul seed și pune partenerii comandabili primii.
 */

vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => null }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "203.0.113.9",
}));
vi.mock("@/lib/security/seller-auth", () => ({ getSellerSessionId: async () => null }));
vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
vi.mock("@/lib/dispatch/auto", () => ({ maybeAutoDispatch: vi.fn() }));
vi.mock("@/lib/payments/eats-stripe", () => ({ createLocalOrderPaymentIntent: vi.fn() }));
vi.mock("@/lib/pricing/delivery", () => ({ resolveDeliveryFee: vi.fn() }));

let merchantRow: Record<string, unknown> | null = null;
const dbQueryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("FROM local_merchants WHERE id")) {
    return { rows: merchantRow ? [merchantRow] : [], rowCount: merchantRow ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
});
const withTransactionMock = vi.fn();
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => dbQueryMock(sql, params),
  withTransaction: (...args: unknown[]) => withTransactionMock(...args),
}));

import { isMerchantOrderable } from "@/lib/merchants/listing-mode";
import { POST } from "@/app/api/local-orders/route";
import { GET } from "@/app/api/merchants/route";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

function orderReq(): Request {
  return new Request("http://localhost/api/local-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      merchant_id: MERCHANT_ID,
      items: [{ menu_item_id: ITEM_ID, qty: 1 }],
      customer_name: "Ana Pop",
      customer_phone: "+40711111111",
      delivery_address: "Str. Exemplu 1, București",
      delivery_lat: 44.43,
      delivery_lng: 26.1,
    }),
  });
}

beforeEach(() => {
  dbQueryMock.mockClear();
  withTransactionMock.mockReset();
  merchantRow = null;
});

describe("isMerchantOrderable", () => {
  it("allows only an explicit 'orderable' listing mode", () => {
    expect(isMerchantOrderable({ listing_mode: "orderable" })).toBe(true);
    expect(isMerchantOrderable({ listing_mode: "suggest_only" })).toBe(false);
    expect(isMerchantOrderable({ listing_mode: null })).toBe(false);
    expect(isMerchantOrderable({})).toBe(false);
  });
});

describe("POST /api/local-orders — unclaimed merchants", () => {
  it("rejects orders to a suggest_only (unclaimed OSM) merchant with 409", async () => {
    merchantRow = { id: MERCHANT_ID, status: "active", listing_mode: "suggest_only", is_open_override: null };
    const res = await POST(orderReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("merchant_not_orderable");
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it("still returns 404 for a merchant that is not active", async () => {
    merchantRow = { id: MERCHANT_ID, status: "suspended", listing_mode: "orderable" };
    const res = await POST(orderReq());
    expect(res.status).toBe(404);
  });

  it("selects listing_mode from the merchant row", async () => {
    merchantRow = { id: MERCHANT_ID, status: "active", listing_mode: "suggest_only" };
    await POST(orderReq());
    const sql = String(dbQueryMock.mock.calls[0][0]);
    expect(sql).toContain("listing_mode");
  });
});

describe("GET /api/merchants — public listing", () => {
  it("exposes listing mode, hides the seeded rating and ranks orderable partners first", async () => {
    const res = await GET(new Request("http://localhost/api/merchants?kind=restaurant"));
    expect(res.status).toBe(200);
    const sql = String(dbQueryMock.mock.calls[0][0]);
    expect(sql).toContain("listing_mode");
    expect(sql).toContain("AS is_orderable");
    expect(sql).toContain("NULL::numeric AS rating");
    expect(sql).toMatch(/ORDER BY \(m\.listing_mode = 'orderable'\) DESC/);
    expect(sql).not.toMatch(/ORDER BY[^;]*rating DESC/);
  });
});
