import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 2026-09-24 (wave2-misc): POST /api/seller/invoices inserted the
 * client-supplied `clientId` straight into `seller_invoices.client_id`
 * without checking it belongs to this seller's own `seller_clients` book —
 * an IDOR letting seller A attach seller B's client to an invoice. Now the
 * route verifies `seller_clients.seller_id = <caller>` first and returns
 * 400 `invalid_client` otherwise.
 */

let sellerId: string | null = "seller-1";
vi.mock("@/lib/security/seller-auth", () => ({
  getSellerSessionId: async () => sellerId,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true }),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// Row returned when the client lookup should succeed; empty when it shouldn't.
let clientOwnershipRows: unknown[] = [{ 1: 1 }];
const dbQueryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes("FROM seller_clients")) {
    return { rows: clientOwnershipRows, rowCount: clientOwnershipRows.length };
  }
  return { rows: [], rowCount: 0 };
});

const withTransactionMock = vi.fn(async (fn: (q: unknown) => Promise<unknown>) => {
  const q = async (_sql: string, _params?: unknown[]) => ({
    rows: [{ id: "inv-1", series: "FACT", number: 1, invoice_number: "FACT-0001" }],
    rowCount: 1,
  });
  return fn(q);
});

vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => dbQueryMock(sql, params),
  withTransaction: (fn: (q: unknown) => Promise<unknown>) => withTransactionMock(fn),
}));

vi.mock("@/lib/seller/sequences", () => ({
  nextSellerSequence: async () => 1,
}));

import { POST } from "@/app/api/seller/invoices/route";

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/seller/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const basePayload = {
  clientName: "Acme SRL",
  items: [{ title: "Produs", quantity: 1, price: 10 }],
};

beforeEach(() => {
  sellerId = "seller-1";
  clientOwnershipRows = [{ 1: 1 }];
  dbQueryMock.mockClear();
  withTransactionMock.mockClear();
});

describe("POST /api/seller/invoices — clientId ownership (IDOR guard)", () => {
  it("rejects a clientId that does not belong to the calling seller", async () => {
    clientOwnershipRows = []; // seller_clients lookup finds nothing for this seller
    const res = await POST(req({ ...basePayload, clientId: "11111111-1111-4111-8111-111111111111" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ success: false, error: "invalid_client" });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it("accepts a clientId that belongs to the calling seller", async () => {
    clientOwnershipRows = [{ 1: 1 }];
    const res = await POST(req({ ...basePayload, clientId: "11111111-1111-4111-8111-111111111111" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("skips the ownership lookup entirely when no clientId is given", async () => {
    const res = await POST(req(basePayload));
    expect(res.status).toBe(201);
    // Singura interogare e profilul fiscal al sellerului (furnizorul facturii), nu seller_clients.
    expect(dbQueryMock.mock.calls.some(([sql]) => String(sql).includes("seller_clients"))).toBe(false);
  });

  it("still requires authentication", async () => {
    sellerId = null;
    const res = await POST(req(basePayload));
    expect(res.status).toBe(401);
  });
});
