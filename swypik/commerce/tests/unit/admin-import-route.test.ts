import { describe, it, expect, vi, beforeEach } from "vitest";

let adminOk = true;
vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: async () =>
    adminOk ? { kind: "admin_user", userId: "admin-1", email: null, username: null, role: "ops", sessionHash: "h" } : null,
}));

const logAdminActionMock = vi.fn(async (_entry: Record<string, unknown>) => undefined);
vi.mock("@/lib/security/admin-audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => logAdminActionMock(entry),
}));

const dbQueryMock = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: "prod-1" }], rowCount: 1 }));
vi.mock("@/lib/db", () => ({
  dbQuery: (sql: string, params?: unknown[]) => dbQueryMock(sql, params),
}));

vi.mock("@/lib/moderation/labelProduct", () => ({ labelProduct: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedProduct: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/admin/import/route";

function req(csv: string): Request {
  return new Request("http://localhost/api/admin/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv }),
  });
}

beforeEach(() => {
  adminOk = true;
  dbQueryMock.mockClear();
  logAdminActionMock.mockClear();
});

describe("POST /api/admin/import", () => {
  it("rejects unauthenticated requests", async () => {
    adminOk = false;
    const res = await POST(req("title,price\nFoo,10"));
    expect(res.status).toBe(401);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it("returns stable error codes (not Romanian sentences) for row-level validation failures", async () => {
    const res = await POST(req("title,price\n,10\nBar,\nBaz,not-a-number"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.errors).toEqual([
      { row: 2, reason: "missing_title", data: { title: "", price: "10" } },
      { row: 3, reason: "missing_price", data: { title: "Bar", price: "" } },
      { row: 4, reason: "invalid_price", params: { price: "not-a-number" }, data: { title: "Baz", price: "not-a-number" } },
    ]);
    expect(json.imported).toBe(0);
  });

  it("imports a valid row and logs an admin audit action", async () => {
    const res = await POST(req("title,price\nGood product,19.99"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.imported).toBe(1);
    expect(logAdminActionMock).toHaveBeenCalledTimes(1);
    expect(logAdminActionMock.mock.calls[0][0]).toMatchObject({
      action: "marketplace_product.bulk_import",
      details: { imported: 1, total: 1, errors: 0 },
    });
  });

  it("returns a stable code when the CSV body is missing", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errors).toEqual([{ row: 0, reason: "no_csv_data" }]);
  });
});
