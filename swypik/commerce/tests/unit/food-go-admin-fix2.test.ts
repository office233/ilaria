/**
 * Audit food-go (fix2): consola de dispecerat Food, upload-ul documentelor,
 * push-ul „comandă nouă” către restaurant, push-uri localizate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  perm: [] as string[],
  admin: true,
  session: { userId: "u-1" } as { userId: string } | null,
  cancel: vi.fn(async () => ({ ok: true, status: "cancelled", refund_status: "succeeded" })),
  reassign: vi.fn(async () => ({ ok: true, status: "searching" })),
  delivered: vi.fn(async () => ({ ok: false, error: "invalid_transition", code: 409 })),
  audit: vi.fn(async () => undefined),
  upload: vi.fn(async () => ({ key: "courier-docs/c-1/x.jpg", url: "https://m/x.jpg", size: 10 })),
  storage: true,
  courier: [{ id: "c-1" }] as unknown[],
  db: [] as { sql: string; params: unknown[] }[],
  notifyRow: [{ order_number: "LO-7", user_id: "seller-user" }] as unknown[],
  push: vi.fn(async () => undefined),
  locale: "en",
}));

vi.mock("@/lib/admin/guard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAdmin: async (_r: Request, perm: string) => {
      h.perm.push(perm);
      return h.admin ? { kind: "admin_user", role: "ops" } : NextResponse.json({ error: "forbidden" }, { status: 403 });
    },
  };
});
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: h.audit }));
vi.mock("@/lib/food/admin-ops", () => ({
  adminCancelFoodOrder: h.cancel,
  adminReassignFoodOrder: h.reassign,
  adminMarkFoodDelivered: h.delivered,
  listActiveFoodOrders: async () => [],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => h.session }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }), getClientIP: () => "1.1.1.1" }));
vi.mock("@/lib/storage/upload", () => ({ uploadFile: h.upload, isStorageConfigured: () => h.storage }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: h.push }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.db.push({ sql, params });
    if (sql.includes("SELECT id FROM couriers WHERE user_id")) return { rows: h.courier, rowCount: 1 };
    if (sql.includes("SET merchant_notified_at = now()")) return { rows: h.notifyRow, rowCount: h.notifyRow.length };
    if (sql.includes("SELECT locale FROM users")) return { rows: [{ locale: h.locale }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

import { POST as foodAction } from "@/app/api/admin/food/orders/[id]/route";
import { POST as uploadDoc } from "@/app/api/couriers/documents/route";
import { notifyMerchantNewOrder } from "@/lib/food/merchant-notify";

const OID = "33333333-3333-4333-8333-333333333333";
const act = (body: unknown, id = OID) =>
  foodAction(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

function docForm(fields: Record<string, string | Blob>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("http://x", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.perm = [];
  h.admin = true;
  h.session = { userId: "u-1" };
  h.storage = true;
  h.courier = [{ id: "c-1" }];
  h.db = [];
  h.notifyRow = [{ order_number: "LO-7", user_id: "seller-user" }];
  h.locale = "en";
});

describe("POST /api/admin/food/orders/[id]", () => {
  it("needs the mobility permission and a valid id/action", async () => {
    h.admin = false;
    expect((await act({ action: "cancel" })).status).toBe(403);
    h.admin = true;
    expect((await act({ action: "cancel" }, "nope")).status).toBe(400);
    expect((await act({ action: "explode" })).status).toBe(400);
    expect(h.perm.every((p) => p === "mobility")).toBe(true);
  });

  it("cancels with refund and audits", async () => {
    const res = await act({ action: "cancel", reason: "stuck" });
    expect(res.status).toBe(200);
    expect(h.cancel).toHaveBeenCalledWith(OID, "stuck");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "food.order_cancel", targetId: OID }));
  });

  it("maps domain errors to their status", async () => {
    expect((await act({ action: "delivered" })).status).toBe(409);
    expect((await act({ action: "reassign" })).status).toBe(200);
  });
});

describe("POST /api/couriers/documents (audit #3)", () => {
  const jpg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], { type: "image/jpeg" });

  it("uploads to storage under the courier prefix and stores only the key, pending review", async () => {
    const res = await uploadDoc(docForm({ doc_type: "rca_insurance", file: jpg, expires_at: "2099-01-01" }));
    expect(res.status).toBe(200);
    expect(h.upload).toHaveBeenCalledWith(expect.any(Buffer), expect.any(String), "image/jpeg", { keyPrefix: "courier-docs/c-1" });
    const upsert = h.db.find((c) => c.sql.includes("INSERT INTO courier_documents"));
    expect(upsert?.params).toEqual(["c-1", "rca_insurance", "courier-docs/c-1/x.jpg", "2099-01-01"]);
    expect(upsert?.sql).toContain("status = 'pending'");
  });

  it("rejects bad input, expired docs, non-couriers and missing storage", async () => {
    expect((await uploadDoc(docForm({ doc_type: "passport", file: jpg }))).status).toBe(400);
    expect((await uploadDoc(docForm({ doc_type: "itp", file: jpg, expires_at: "2001-01-01" }))).status).toBe(400);
    h.courier = [];
    expect((await uploadDoc(docForm({ doc_type: "itp", file: jpg }))).status).toBe(403);
    h.storage = false;
    expect((await uploadDoc(docForm({ doc_type: "itp", file: jpg }))).status).toBe(503);
    h.session = null;
    expect((await uploadDoc(docForm({ doc_type: "itp", file: jpg }))).status).toBe(401);
  });
});

describe("merchant new-order push (audit #7)", () => {
  it("pushes once, in the seller's language, only for cash or authorized card orders", async () => {
    expect(await notifyMerchantNewOrder(OID)).toBe(true);
    const sql = h.db.find((c) => c.sql.includes("merchant_notified_at"))?.sql ?? "";
    expect(sql).toContain("merchant_notified_at IS NULL");
    expect(sql).toContain("payment_authorized_at IS NOT NULL");
    expect(h.push).toHaveBeenCalledWith(
      "seller-user",
      expect.objectContaining({ title: "New order #LO-7", url: "/seller/merchant", tag: `merchant-order-${OID}` }),
    );
  });

  it("does nothing when already notified", async () => {
    h.notifyRow = [];
    expect(await notifyMerchantNewOrder(OID)).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
  });
});
