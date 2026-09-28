import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ inserted: [] as unknown[][] }));

vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => ({ userId: "host-1", role: "seller" }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT creator_id FROM live_streams")) return { rows: [{ creator_id: "host-1" }], rowCount: 1 };
    if (sql.includes("FROM marketplace_products p")) return { rows: [{ price_cents: 10_000, seller_user_id: "host-1", merchant_user_id: null }], rowCount: 1 };
    if (sql.includes("INSERT INTO live_shop_items")) {
      h.inserted.push(params);
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { POST } from "@/app/api/live/streams/[id]/items/route";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const post = (body: unknown) =>
  POST(new Request(`http://x/api/live/streams/${ID}/items`, { method: "POST", body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  h.inserted = [];
});

describe("POST /api/live/streams/[id]/items — body validat (nu 500)", () => {
  it("flash_until invalid → 400 (înainte RangeError → 500)", async () => {
    expect((await post({ product_id: "p1", flash_until: "mâine" })).status).toBe(400);
  });
  it("display_order non-numeric → 400 (înainte NaN → 500)", async () => {
    expect((await post({ product_id: "p1", display_order: "x" })).status).toBe(400);
  });
  it("fără product_id → 400", async () => {
    expect((await post({})).status).toBe(400);
  });
  it("body valid → inserat cu data normalizată", async () => {
    const res = await post({ product_id: "p1", display_order: 2, flash_price_cents: 5_000, flash_until: "2026-10-01T10:00:00+03:00" });
    expect(res.status).toBe(200);
    expect(h.inserted[0]).toEqual([ID, "p1", 2, false, 5_000, "2026-10-01T07:00:00.000Z"]);
  });
});
