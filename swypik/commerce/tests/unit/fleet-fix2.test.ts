/**
 * Audit food-go (fix2): RBAC pe rutele de flotă/parteneri/plăți, documentele
 * obligatorii la aprobare, ștergerea logică, aplicația cu cont obligatoriu,
 * re-verificarea la schimbarea vehiculului, respingerea atomică a payout-ului.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { sql: string; params: unknown[] };
const h = vi.hoisted(() => ({
  perms: [] as string[],
  admin: true,
  session: { userId: "u-1" } as { userId: string } | null,
  calls: [] as { sql: string; params: unknown[] }[],
  tx: [] as { sql: string; params: unknown[] }[],
  approvedDocs: [] as string[],
  courier: { id: "c-1", verification_status: "approved", vehicle_type: "car", vehicle_plate: "B 11 ABC", city: "București" } as Record<string, unknown> | null,
  payout: { id: "p-1", user_id: "u-9", amount_cents: "5000", status: "pending" } as Record<string, unknown> | null,
  credit: vi.fn(async () => ({ alreadyApplied: false })),
  audit: vi.fn(async () => undefined),
  email: vi.fn(async () => undefined),
}));

vi.mock("@/lib/admin/guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAdmin: async (_req: Request, perm: string) => {
      h.perms.push(perm);
      return h.admin ? { kind: "admin_user", role: "ops" } : NextResponse.json({ error: "forbidden" }, { status: 403 });
    },
  };
});
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: h.audit }));
vi.mock("@/lib/email/service", () => ({ sendEmail: h.email }));
vi.mock("@/lib/email/templates/fleet", () => ({ sendFleetDecisionEmail: h.email, sendFleetPartnerDecisionEmail: h.email }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => h.session }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }), getClientIP: () => "203.0.113.9" }));
vi.mock("@/lib/rides/settings", () => ({
  getGoSettings: async () => ({ required_driver_documents: ["id_card", "rca_insurance"] }),
}));
vi.mock("@/lib/drivers/tiers", () => ({
  assignTierOnApproval: async () => ({ tier: "founding15" }),
  getTierParams: async () => ({ promoDays: 60 }),
  getTierSlots: async () => ({ founding_total: 500 }),
  TIER_COMMISSION_PCT: { founding15: 15, early18: 18, standard20: 20 },
}));
vi.mock("@/lib/drivers/referral", () => ({ getOrCreateDriverCode: async () => "CODE<1>" }));
vi.mock("@/lib/wallet/ledger", () => ({ creditUserTx: h.credit }));
vi.mock("@/lib/food/claims", () => ({ approveClaim: vi.fn(), rejectClaim: vi.fn(async () => ({ ok: true })) }));

function run(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  if (sql.includes("SELECT kind FROM couriers")) return { rows: [{ kind: "driver" }], rowCount: 1 };
  if (sql.includes("FROM courier_documents") && sql.includes("status = 'approved'")) {
    return { rows: h.approvedDocs.map((doc_type) => ({ doc_type })), rowCount: h.approvedDocs.length };
  }
  if (sql.includes("UPDATE couriers") && sql.includes("RETURNING id, kind")) {
    return { rows: [{ id: "c-1", kind: "driver", full_name: "Ion <b>Pop</b>", email: "i@x.ro", verification_status: "approved" }], rowCount: 1 };
  }
  if (sql.includes("SELECT id, verification_status, vehicle_type")) return { rows: h.courier ? [h.courier] : [], rowCount: 1 };
  if (sql.includes("UPDATE couriers SET")) return { rows: [{ id: "c-1" }], rowCount: 1 };
  if (sql.includes("FROM payout_requests") && sql.includes("FOR UPDATE")) return { rows: h.payout ? [h.payout] : [], rowCount: 1 };
  void params;
  return { rows: [], rowCount: 0 };
}

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    return run(sql, params);
  }),
  withTransaction: vi.fn(async (fn: (q: (sql: string, params?: unknown[]) => unknown) => unknown) =>
    fn(async (sql: string, params: unknown[] = []) => {
      h.tx.push({ sql, params });
      return run(sql, params);
    }),
  ),
}));

import { PATCH as fleetPatch } from "@/app/api/admin/fleet/[id]/route";
import { PATCH as partnerPatch } from "@/app/api/admin/fleet-partners/[id]/route";
import { POST as merchantApprove } from "@/app/api/admin/merchants/[id]/approve/route";
import { POST as merchantReject } from "@/app/api/admin/merchants/[id]/reject/route";
import { POST as claimReview } from "@/app/api/admin/merchant-claims/[id]/route";
import { GET as payoutsGet, POST as payoutsPost } from "@/app/api/admin/courier-payouts/route";
import { POST as courierApply, PATCH as courierPatch } from "@/app/api/couriers/route";
import { courierRequiredDocumentsFromEnv, missingDocuments } from "@/lib/fleet/documents";
import { escapeHtml } from "@/lib/fleet/escape-html";

const ID = "11111111-1111-4111-8111-111111111111";
const req = (body: unknown, method = "PATCH") =>
  new Request("http://localhost/x", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.perms = [];
  h.admin = true;
  h.session = { userId: "u-1" };
  h.calls = [];
  h.tx = [];
  h.approvedDocs = [];
  h.courier = { id: "c-1", verification_status: "approved", vehicle_type: "car", vehicle_plate: "B 11 ABC", city: "București" };
  h.payout = { id: "p-1", user_id: "u-9", amount_cents: "5000", status: "pending" };
});

describe("admin RBAC (audit #5)", () => {
  it("uses the right permission on every fleet/partner/payout route", async () => {
    await fleetPatch(req({ action: "suspend" }), ctx());
    await partnerPatch(req({ action: "suspend" }), ctx());
    await merchantApprove(req({}, "POST"), ctx());
    await merchantReject(req({}, "POST"), ctx());
    await claimReview(req({ action: "reject" }, "POST"), ctx());
    await payoutsGet(new Request("http://localhost/x"));
    await payoutsPost(req({ id: ID, action: "paid" }, "POST"));
    expect(h.perms).toEqual(["mobility", "mobility", "partners", "partners", "partners", "finance", "finance"]);
  });

  it("returns the guard's 403 without touching the DB", async () => {
    h.admin = false;
    expect((await fleetPatch(req({ action: "delete" }), ctx())).status).toBe(403);
    expect((await payoutsPost(req({ id: ID, action: "paid" }, "POST"))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects non-UUID merchant ids with 400 (audit #14)", async () => {
    expect((await merchantApprove(req({}, "POST"), ctx("abc"))).status).toBe(400);
    expect((await merchantReject(req({}, "POST"), ctx("abc"))).status).toBe(400);
  });
});

describe("PATCH /api/admin/fleet/[id]", () => {
  it("refuses approval while required documents are missing or expired (audit #2)", async () => {
    h.approvedDocs = ["id_card"];
    const res = await fleetPatch(req({ action: "approve" }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "documents_missing", missing: ["rca_insurance"] });
    expect(h.calls.some((c) => c.sql.includes("verification_status='approved'"))).toBe(false);
  });

  it("approves when all documents are valid and hands raw user text to the escaping template (audit #22)", async () => {
    h.approvedDocs = ["id_card", "rca_insurance"];
    const res = await fleetPatch(req({ action: "approve" }), ctx());
    expect(res.status).toBe(200);
    // Escaparea HTML e în lib/email (acoperită în email-templates.test.ts).
    const input = (h.email.mock.calls[0] as unknown as [{ name: string; referralCode: string; decision: string; kind: string }])[0];
    expect(input).toMatchObject({ name: "Ion <b>Pop</b>", referralCode: "CODE<1>", decision: "approve", kind: "driver" });
  });

  it("soft-deletes instead of DELETE (audit #28)", async () => {
    expect((await fleetPatch(req({ action: "delete" }), ctx())).status).toBe(200);
    const sqls = h.calls.map((c) => c.sql).join("\n");
    expect(sqls).toContain("deleted_at=now()");
    expect(sqls).not.toMatch(/DELETE FROM couriers/);
  });

  it("validates the action", async () => {
    expect((await fleetPatch(req({ action: "nuke" }), ctx())).status).toBe(400);
    expect((await fleetPatch(req({ action: "approve" }), ctx("x"))).status).toBe(400);
  });
});

describe("POST /api/admin/courier-payouts — atomic reject", () => {
  it("locks, updates and refunds in one transaction", async () => {
    const res = await payoutsPost(req({ id: ID, action: "rejected" }, "POST"));
    expect(res.status).toBe(200);
    expect(h.tx[0].sql).toContain("FOR UPDATE");
    expect(h.tx.some((c) => c.sql.includes("UPDATE payout_requests"))).toBe(true);
    expect(h.credit).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ userId: "u-9", amountCents: 5000, refType: "payout_refund" }));
  });

  it("409 when the payout is no longer pending; no refund", async () => {
    h.payout = { ...h.payout, status: "paid" };
    expect((await payoutsPost(req({ id: ID, action: "rejected" }, "POST"))).status).toBe(409);
    expect(h.credit).not.toHaveBeenCalled();
  });
});

describe("/api/couriers", () => {
  it("requires an account to apply (audit #6)", async () => {
    h.session = null;
    const res = await courierApply(req({ kind: "driver", full_name: "Ion Pop", phone: "0712345678", city: "Cluj" }, "POST"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_required" });
  });

  it("sends an approved driver back to review when the plate changes (audit #4)", async () => {
    const res = await courierPatch(req({ vehicle_plate: "CJ 99 XYZ" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reverification: true });
    const update = h.calls.find((c) => c.sql.startsWith("UPDATE couriers SET"));
    expect(update?.sql).toContain("verification_status = 'in_review'");
    expect(h.calls.some((c) => c.sql.includes("UPDATE courier_documents SET status = 'pending'"))).toBe(true);
  });

  it("does not re-verify on a cosmetic plate edit (spacing/case)", async () => {
    const res = await courierPatch(req({ vehicle_plate: "b11abc" }));
    expect(await res.json()).toMatchObject({ reverification: false });
  });

  it("refuses legacy jsonb documents", async () => {
    const res = await courierPatch(req({ documents: { id_card: "https://x.ro/a.jpg" } }));
    expect(res.status).toBe(400);
  });
});

describe("lib/fleet", () => {
  it("parses the courier required documents from env", () => {
    expect(courierRequiredDocumentsFromEnv(undefined)).toEqual(["id_card"]);
    expect(courierRequiredDocumentsFromEnv("")).toEqual([]);
    expect(courierRequiredDocumentsFromEnv("id_card, bogus ,criminal_record")).toEqual(["id_card", "criminal_record"]);
  });

  it("missingDocuments only counts approved, unexpired docs", async () => {
    h.approvedDocs = ["id_card"];
    expect(await missingDocuments("c-1", ["id_card", "itp"])).toEqual(["itp"]);
    const sql = h.calls.at(-1)?.sql ?? "";
    expect(sql).toContain("expires_at IS NULL OR expires_at >= current_date");
    expect(await missingDocuments("c-1", [])).toEqual([]);
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});
