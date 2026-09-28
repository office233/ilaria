import { describe, it, expect, vi, beforeEach } from "vitest";

/** w2-food: revendicarea restaurantelor nerevendicate (lib + rute). */

vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});
let sessionUser: string | null = "user-1";
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => (sessionUser ? { userId: sessionUser } : null) }));
let rlOk = true;
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: rlOk, remaining: 1 }), getClientIP: () => "203.0.113.9" }));
let admin = true;
vi.mock("@/lib/admin/guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAdmin: async (_req: Request, perm: string) =>
      admin && perm === "partners" ? { kind: "admin_user", role: "ops" } : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
  };
});
const logAdminAction = vi.fn();
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: (e: unknown) => logAdminAction(e) }));

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
let merchantRow: Record<string, unknown> | null = null;
let claimRow: Record<string, unknown> | null = null;
let sellerByUser: Record<string, unknown> | null = null;
let sellerByEmail: Record<string, unknown> | null = null;
let insertReturns = true;
const txCalls: [string, unknown[]][] = [];

const q: Q = async (sql, params = []) => {
  txCalls.push([sql, params]);
  if (sql.includes("FROM merchant_claim_requests c")) return { rows: claimRow ? [claimRow] : [], rowCount: claimRow ? 1 : 0 };
  if (sql.includes("FROM sellers WHERE user_id")) return { rows: sellerByUser ? [sellerByUser] : [], rowCount: 0 };
  if (sql.includes("FROM sellers WHERE lower(email)")) return { rows: sellerByEmail ? [sellerByEmail] : [], rowCount: 0 };
  if (sql.includes("INSERT INTO sellers")) return { rows: [{ id: "seller-new" }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
};
const dbQuery = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes("FROM local_merchants WHERE id")) return { rows: merchantRow ? [merchantRow] : [], rowCount: 0 };
  if (sql.includes("INSERT INTO merchant_claim_requests")) return insertReturns ? { rows: [{ id: "claim-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes("SET status = 'rejected'")) return { rows: [], rowCount: claimRow ? 1 : 0 };
  return q(sql, params);
});
vi.mock("@/lib/db", () => ({
  dbQuery: (s: string, p?: unknown[]) => dbQuery(s, p),
  withTransaction: async (fn: (qq: Q) => Promise<unknown>) => fn(q),
}));

import { approveClaim, createClaim } from "@/lib/food/claims";
import { POST as claimPOST } from "@/app/api/merchants/[id]/claim/route";
import { POST as adminPOST } from "@/app/api/admin/merchant-claims/[id]/route";

const MID = "44444444-4444-4444-8444-444444444444";
const CID = "55555555-5555-4555-8555-555555555555";
const pendingClaim = {
  id: CID, status: "pending", merchant_id: MID, user_id: "user-1", contact_phone: "+40711111111",
  contact_email: null, merchant_name: "Bistro Ana", merchant_seller_id: null, user_email: "Ana@Example.com",
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sqlOf = (needle: string) => txCalls.find(([s]) => s.includes(needle));

beforeEach(() => {
  vi.clearAllMocks();
  txCalls.length = 0;
  sessionUser = "user-1";
  rlOk = true;
  admin = true;
  insertReturns = true;
  merchantRow = { id: MID, seller_id: null, status: "active" };
  claimRow = { ...pendingClaim };
  sellerByUser = null;
  sellerByEmail = null;
});

describe("createClaim", () => {
  it("creates a pending claim for an unclaimed merchant", async () => {
    expect(await createClaim({ merchantId: MID, userId: "user-1", contactPhone: "+40711111111" })).toEqual({ ok: true, claimId: "claim-1" });
  });
  it("refuses a merchant that already has an owner", async () => {
    merchantRow = { id: MID, seller_id: "s1", status: "active" };
    expect(await createClaim({ merchantId: MID, userId: "user-1", contactPhone: "+40711111111" })).toEqual({ ok: false, code: "not_claimable" });
  });
  it("reports a duplicate pending claim", async () => {
    insertReturns = false;
    expect(await createClaim({ merchantId: MID, userId: "user-1", contactPhone: "+40711111111" })).toEqual({ ok: false, code: "claim_pending" });
  });
});

describe("approveClaim", () => {
  it("creates a seller for the claimant, links it and makes the merchant orderable", async () => {
    const r = await approveClaim(CID, "ok");
    expect(r).toEqual({ ok: true, sellerId: "seller-new", merchantId: MID, createdSeller: true });
    expect(sqlOf("INSERT INTO sellers")?.[1]).toEqual(["Bistro Ana", "ana@example.com", "+40711111111", "user-1", MID]);
    const upd = sqlOf("UPDATE local_merchants");
    expect(upd?.[0]).toContain("listing_mode = 'orderable'");
    expect(upd?.[1]).toEqual([MID, "seller-new"]);
    expect(sqlOf("review_note = 'superseded'")).toBeTruthy();
  });

  it("reuses the claimant's existing seller account", async () => {
    sellerByUser = { id: "seller-7", status: "active" };
    const r = await approveClaim(CID, null);
    expect(r).toMatchObject({ ok: true, sellerId: "seller-7", createdSeller: false });
    expect(sqlOf("INSERT INTO sellers")).toBeUndefined();
  });

  it("links a seller found by email only if it isn't owned by another user", async () => {
    sellerByEmail = { id: "seller-9", status: "pending", user_id: "someone-else" };
    expect(await approveClaim(CID, null)).toEqual({ ok: false, code: "seller_email_conflict" });
    expect(sqlOf("UPDATE local_merchants")).toBeUndefined();
  });

  it("refuses already processed or already claimed requests", async () => {
    claimRow = { ...pendingClaim, status: "approved" };
    expect(await approveClaim(CID, null)).toEqual({ ok: false, code: "not_pending" });
    claimRow = { ...pendingClaim, merchant_seller_id: "s1" };
    expect(await approveClaim(CID, null)).toEqual({ ok: false, code: "already_claimed" });
  });
});

describe("POST /api/merchants/[id]/claim", () => {
  const body = { contact_name: "Ana Pop", contact_phone: "+40711111111" };
  it("requires login", async () => {
    sessionUser = null;
    const res = await claimPOST(jsonReq("http://x/api/merchants/claim", body), ctx(MID));
    expect(res.status).toBe(401);
  });
  it("is rate limited", async () => {
    rlOk = false;
    const res = await claimPOST(jsonReq("http://x/api/merchants/claim", body), ctx(MID));
    expect(res.status).toBe(429);
  });
  it("validates input", async () => {
    const res = await claimPOST(jsonReq("http://x/api/merchants/claim", { contact_name: "A" }), ctx(MID));
    expect(res.status).toBe(400);
  });
  it("creates the claim", async () => {
    const res = await claimPOST(jsonReq("http://x/api/merchants/claim", body), ctx(MID));
    expect(res.status).toBe(201);
    expect((await res.json()).claim_id).toBe("claim-1");
  });
});

describe("POST /api/admin/merchant-claims/[id]", () => {
  it("requires an admin session", async () => {
    admin = false;
    const res = await adminPOST(jsonReq("http://x", { action: "approve" }), ctx(CID));
    expect(res.status).toBe(401);
  });
  it("approves and audits", async () => {
    const res = await adminPOST(jsonReq("http://x", { action: "approve" }), ctx(CID));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: "merchant_claim.approve", targetId: CID }));
  });
  it("maps approval conflicts to 409", async () => {
    claimRow = { ...pendingClaim, merchant_seller_id: "s1" };
    const res = await adminPOST(jsonReq("http://x", { action: "approve" }), ctx(CID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("already_claimed");
  });
  it("rejects a pending claim", async () => {
    const res = await adminPOST(jsonReq("http://x", { action: "reject", note: "nu e proprietarul" }), ctx(CID));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: "merchant_claim.reject" }));
  });
});
