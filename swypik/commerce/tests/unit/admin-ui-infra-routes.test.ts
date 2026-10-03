/**
 * Rutele de admin „admin-ui-infra” (audit 2026-09-28): RBAC cu permisiunea
 * minimă (nu „orice admin”), tranzacții reale, tranziții de stare idempotente.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminActor } from "@/lib/security/admin-auth";
import {
  FINANCE,
  MACHINE,
  MODERATOR,
  OPS,
  OWNER,
  SUPPORT,
  TARGET_USER,
  TARGET_VIDEO,
  idParams,
  jsonReq,
} from "./helpers/admin-actors";

type Res = { rows: unknown[]; rowCount: number };
type Call = { sql: string; params: unknown[] };

const h = vi.hoisted(() => ({
  actor: null as AdminActor | null,
  db: [] as Call[],
  tx: [] as Call[],
  txCount: 0,
  audit: [] as Record<string, unknown>[],
  notify: [] as unknown[][],
  dbHandler: null as null | ((sql: string, params: unknown[]) => Res | undefined),
  txHandler: null as null | ((sql: string, params: unknown[]) => Res | undefined),
}));

vi.mock("@/lib/db", () => {
  const empty = { rows: [], rowCount: 0 };
  const dbQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    h.db.push({ sql, params });
    return h.dbHandler?.(sql, params) ?? empty;
  });
  const txq = async (sql: string, params: unknown[] = []) => {
    h.tx.push({ sql, params });
    return h.txHandler?.(sql, params) ?? empty;
  };
  return {
    dbQuery,
    dbQueryLong: dbQuery,
    getDb: () => ({ connect: async () => ({ query: dbQuery, release: () => undefined }), query: dbQuery }),
    getPool: () => ({ connect: async () => ({ query: dbQuery, release: () => undefined }), query: dbQuery }),
    withTransaction: async (fn: (q: typeof txq) => unknown) => {
      h.txCount += 1;
      return fn(txq);
    },
    withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
  };
});
vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: async () => h.actor,
  getAdminActor: async () => h.actor,
  revokeAdminSessionsForUser: async () => undefined,
}));
vi.mock("@/lib/security/admin-audit", () => ({
  logAdminAction: async (e: Record<string, unknown>) => void h.audit.push(e),
}));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags")>()),
  isEnabled: () => true,
}));
vi.mock("@/lib/notifications/localized", () => ({
  notifyLocalized: async (...a: unknown[]) => void h.notify.push(a),
}));
vi.mock("@/lib/creator/application-notify", () => ({
  notifyApplicationDecision: async (...a: unknown[]) => void h.notify.push(a),
}));
vi.mock("@/lib/email/creator-notifications", () => ({
  notifyVideoApproved: vi.fn(async () => true),
  notifyVideoRejected: vi.fn(async () => true),
}));
vi.mock("@/lib/ai/auto-embed", () => ({ autoEmbedVideo: vi.fn(), autoEmbedProduct: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ notifyOps: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

import * as applicationApprove from "@/app/api/admin/applications/[id]/approve/route";
import * as applicationReject from "@/app/api/admin/applications/[id]/reject/route";
import * as creatorFund from "@/app/api/admin/creator-fund/route";
import * as cronTrigger from "@/app/api/admin/cron/[jobName]/trigger/route";
import * as disputes from "@/app/api/admin/disputes/route";
import * as disputeSuggest from "@/app/api/admin/disputes/[disputeId]/suggest/route";
import * as disputeUpload from "@/app/api/admin/disputes/[disputeId]/upload/route";
import * as financeSummary from "@/app/api/admin/finance/summary/route";
import * as fulfillment from "@/app/api/admin/fulfillment/route";
import * as importRoute from "@/app/api/admin/import/route";
import * as marketplace from "@/app/api/admin/marketplace/route";
import * as orders from "@/app/api/admin/orders/route";
import * as fraudDecision from "@/app/api/admin/orders/[id]/fraud-decision/route";
import * as ordersRisk from "@/app/api/admin/orders/risk/route";
import * as returnApprove from "@/app/api/admin/returns/[orderId]/approve/route";
import * as returnReject from "@/app/api/admin/returns/[orderId]/reject/route";
import * as review from "@/app/api/admin/reviews/[id]/route";
import * as reviewHide from "@/app/api/admin/reviews/[id]/hide/route";
import * as reviewUnhide from "@/app/api/admin/reviews/[id]/unhide/route";
import * as strikes from "@/app/api/admin/strikes/route";
import * as videos from "@/app/api/admin/videos/route";
import * as reencode from "@/app/api/admin/videos/[id]/reencode/route";
import * as dismissReport from "@/app/api/admin/moderation/[id]/dismiss/route";

const ID = "44444444-4444-4444-8444-444444444444";
const DP = "dp_TEST123";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
/** Handler-ele au tipuri de params diferite; în test le apelăm uniform. */
const H = (fn: unknown) => fn as Handler;
type Perm = "finance" | "system" | "commerce" | "partners" | "moderation" | "content";

/** Un actor căruia îi lipsește permisiunea (support nu are bani/sistem/moderare/conținut/parteneri). */
const LACKS: Record<Perm, AdminActor> = {
  finance: SUPPORT,
  system: SUPPORT,
  partners: SUPPORT,
  moderation: SUPPORT,
  content: SUPPORT,
  commerce: MODERATOR,
};

const ROUTES: [string, Handler, string, Record<string, string>, Perm][] = [
  ["POST applications/[id]/approve", H(applicationApprove.POST), "POST", { id: ID }, "partners"],
  ["POST applications/[id]/reject", H(applicationReject.POST), "POST", { id: ID }, "partners"],
  ["GET creator-fund", H(creatorFund.GET), "GET", {}, "finance"],
  ["POST creator-fund", H(creatorFund.POST), "POST", {}, "finance"],
  ["POST cron/[jobName]/trigger", H(cronTrigger.POST), "POST", { jobName: "process-payouts" }, "system"],
  ["GET disputes", H(disputes.GET), "GET", {}, "finance"],
  ["POST disputes", H(disputes.POST), "POST", {}, "finance"],
  ["GET disputes/[id]/suggest", H(disputeSuggest.GET), "GET", { disputeId: DP }, "finance"],
  ["POST disputes/[id]/upload", H(disputeUpload.POST), "POST", { disputeId: DP }, "finance"],
  ["GET finance/summary", H(financeSummary.GET), "GET", {}, "finance"],
  ["POST fulfillment", H(fulfillment.POST), "POST", {}, "commerce"],
  ["POST import", H(importRoute.POST), "POST", {}, "commerce"],
  ["GET marketplace", H(marketplace.GET), "GET", {}, "commerce"],
  ["GET orders", H(orders.GET), "GET", {}, "commerce"],
  ["PATCH orders", H(orders.PATCH), "PATCH", {}, "commerce"],
  ["POST orders/[id]/fraud-decision", H(fraudDecision.POST), "POST", { id: ID }, "commerce"],
  ["GET orders/risk", H(ordersRisk.GET), "GET", {}, "commerce"],
  ["POST returns/[id]/approve", H(returnApprove.POST), "POST", { orderId: ID }, "commerce"],
  ["POST returns/[id]/reject", H(returnReject.POST), "POST", { orderId: ID }, "commerce"],
  ["DELETE reviews/[id]", H(review.DELETE), "DELETE", { id: ID }, "moderation"],
  ["POST reviews/[id]/hide", H(reviewHide.POST), "POST", { id: ID }, "moderation"],
  ["POST reviews/[id]/unhide", H(reviewUnhide.POST), "POST", { id: ID }, "moderation"],
  ["GET strikes", H(strikes.GET), "GET", {}, "moderation"],
  ["POST strikes", H(strikes.POST), "POST", {}, "moderation"],
  ["GET videos", H(videos.GET), "GET", {}, "content"],
  ["POST videos", H(videos.POST), "POST", {}, "content"],
  ["POST videos/[id]/reencode", H(reencode.POST), "POST", { id: ID }, "content"],
];

function call(handler: Handler, method: string, params: Record<string, string>, body: unknown = {}) {
  const req = new Request("http://localhost/api/admin/x", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

const writes = () =>
  [...h.db, ...h.tx].filter((c) => /^\s*(INSERT|UPDATE|DELETE|BEGIN)/i.test(c.sql));

beforeEach(() => {
  h.actor = OWNER;
  h.db = [];
  h.tx = [];
  h.txCount = 0;
  h.audit = [];
  h.notify = [];
  h.dbHandler = null;
  h.txHandler = null;
});

describe("RBAC: least-privilege permission per route", () => {
  it.each(ROUTES)("%s → 401 without a session, 403 without the permission, no writes", async (_l, handler, method, params, perm) => {
    h.actor = null;
    expect((await call(handler, method, params)).status).toBe(401);
    h.actor = LACKS[perm];
    const res = await call(handler, method, params);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(writes()).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("support can no longer pay / trigger crons / moderate: explicit spot checks", async () => {
    h.actor = SUPPORT;
    expect((await call(H(creatorFund.POST), "POST", {}, { month: "2026-08", poolCents: 100 })).status).toBe(403);
    expect((await call(H(cronTrigger.POST), "POST", { jobName: "suspend-unverified" })).status).toBe(403);
    expect((await call(H(reviewHide.POST), "POST", { id: ID })).status).toBe(403);
    expect((await call(H(strikes.POST), "POST", {}, { strikeId: ID })).status).toBe(403);
  });

  it("cron trigger: money jobs additionally need `finance` (ops has system but not finance)", async () => {
    h.actor = OPS;
    const res = await call(H(cronTrigger.POST), "POST", { jobName: "process-payouts" });
    expect(res.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("Bearer ADMIN_SECRET (machine actor) still passes the guard", async () => {
    h.actor = MACHINE;
    h.dbHandler = () => ({ rows: [], rowCount: 0 });
    const res = await call(H(financeSummary.GET), "GET", {});
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("reviews hide/unhide/delete run in withTransaction (no BEGIN on the pool)", () => {
  const REVIEW = { user_id: TARGET_USER, product_id: "p1", is_hidden: false, rating: 2 };

  it("hide: one transaction with the UPDATE + moderation action, audited with the actor", async () => {
    h.actor = MODERATOR;
    h.txHandler = (sql) => {
      if (sql.includes("FROM product_reviews")) return { rows: [REVIEW], rowCount: 1 };
      if (sql.startsWith("UPDATE product_reviews")) return { rows: [], rowCount: 1 };
      return undefined;
    };
    const res = await call(H(reviewHide.POST), "POST", { id: ID }, { reason: "spam" });
    expect(res.status).toBe(200);
    expect(h.txCount).toBe(1);
    expect(h.db.some((c) => /BEGIN|COMMIT|ROLLBACK/.test(c.sql))).toBe(false);
    expect(h.tx[0].sql).toContain("FOR UPDATE");
    expect(h.tx.some((c) => c.sql.includes("INSERT INTO moderation_actions") && c.params[0] === MODERATOR.userId)).toBe(true);
    expect(h.audit[0]).toMatchObject({ action: "review.hide", actor: MODERATOR });
  });

  it("hide on an already hidden review writes no second moderation action", async () => {
    h.actor = MODERATOR;
    h.txHandler = (sql) => {
      if (sql.includes("FROM product_reviews")) return { rows: [{ ...REVIEW, is_hidden: true }], rowCount: 1 };
      if (sql.startsWith("UPDATE product_reviews")) return { rows: [], rowCount: 0 };
      return undefined;
    };
    const res = await call(H(reviewHide.POST), "POST", { id: ID });
    expect(res.status).toBe(200);
    expect(h.tx.some((c) => c.sql.includes("INSERT INTO moderation_actions"))).toBe(false);
    expect(h.audit).toHaveLength(0);
  });

  it("unhide + delete store stable reason codes, not Romanian sentences", async () => {
    h.actor = MODERATOR;
    h.txHandler = (sql) => {
      if (sql.includes("FROM product_reviews")) return { rows: [{ ...REVIEW, is_hidden: true }], rowCount: 1 };
      if (sql.startsWith("UPDATE product_reviews")) return { rows: [], rowCount: 1 };
      return undefined;
    };
    expect((await call(H(reviewUnhide.POST), "POST", { id: ID })).status).toBe(200);
    expect((await call(H(review.DELETE), "DELETE", { id: ID })).status).toBe(200);
    const reasons = h.tx.filter((c) => c.sql.includes("INSERT INTO moderation_actions")).map((c) => c.params.find((p) => typeof p === "string" && p.startsWith("review_")));
    expect(reasons).toEqual(["review_restored_by_moderator", "review_deleted_by_moderator"]);
    expect(h.db.some((c) => /BEGIN|COMMIT/.test(c.sql))).toBe(false);
  });

  it("rejects ids that only look like a uuid (dashes only)", async () => {
    const res = await call(H(reviewHide.POST), "POST", { id: "-".repeat(36) });
    expect(res.status).toBe(400);
  });
});

describe("returns approve/reject are one-shot state transitions", () => {
  let order: { return_status: string | null; status: string; total_cents: number };

  beforeEach(() => {
    order = { return_status: "requested", status: "delivered", total_cents: 5000 };
    h.actor = OPS;
    h.txHandler = (sql) => {
      if (sql.includes("FROM commerce_orders")) {
        return { rows: [{ id: ID, status: order.status, total_cents: order.total_cents, return_status: order.return_status }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE commerce_orders")) {
        expect(sql).toContain("= 'requested'");
        const pending = (order.return_status ?? (order.status === "return_requested" ? "requested" : null)) === "requested";
        if (!pending) return { rows: [], rowCount: 0 };
        order.return_status = sql.includes("'approved'") ? "approved" : "rejected";
        return { rows: [{ buyer_user_id: TARGET_USER }], rowCount: 1 };
      }
      return undefined;
    };
  });

  const moderationInserts = () => h.tx.filter((c) => c.sql.includes("INSERT INTO moderation_actions"));
  const approve = (body: unknown = {}) => call(H(returnApprove.POST), "POST", { orderId: ID }, body);
  const reject = () => call(H(returnReject.POST), "POST", { orderId: ID }, { reason: "damaged item" });

  it("approve twice → 200 then 409; the buyer 'warn' / refund record is written once", async () => {
    const first = await approve({ refundAmountCents: 3000 });
    expect(first.status).toBe(200);
    expect((await first.json()).refundAmountCents).toBe(3000);
    const second = await approve({ refundAmountCents: 3000 });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("return_not_pending");
    expect(moderationInserts()).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    expect(h.txCount).toBe(2);
    expect(h.tx[0].sql).toContain("FOR UPDATE");
  });

  it("reject after approve → 409, no second moderation action", async () => {
    expect((await approve()).status).toBe(200);
    expect((await reject()).status).toBe(409);
    expect(order.return_status).toBe("approved");
    expect(moderationInserts()).toHaveLength(1);
  });

  it("reject from requested → 200; refund above the order total → 400", async () => {
    expect((await approve({ refundAmountCents: 999_999 })).status).toBe(400);
    expect((await reject()).status).toBe(200);
    expect(order.return_status).toBe("rejected");
  });
});

describe("videos legacy approve/reject", () => {
  let video: { status: string; moderation_status: string };

  beforeEach(() => {
    video = { status: "processing", moderation_status: "pending_review" };
    h.actor = MODERATOR;
    h.txHandler = (sql) => {
      if (sql.includes("FROM video_assets va") && sql.includes("FOR UPDATE")) {
        expect(sql).toContain("<> 'deleted'");
        if (video.status === "deleted") return { rows: [], rowCount: 0 };
        return {
          rows: [{ video_id: TARGET_VIDEO, moderation_status: video.moderation_status, title: "t", description: null, creator_id: TARGET_USER }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("UPDATE videos")) {
        expect(sql).toContain("<> 'deleted'");
        video.status = sql.includes("'failed'") ? "failed" : "ready";
        if (sql.includes("moderation_status = 'rejected'")) video.moderation_status = "rejected";
        else if (sql.includes("'pending_review' THEN 'approved'") && video.moderation_status === "pending_review") video.moderation_status = "approved";
        return { rows: [], rowCount: 1 };
      }
      return undefined;
    };
  });

  const post = (body: unknown) => call(H(videos.POST), "POST", {}, body);

  it("does not publish (resurrect) a deleted video", async () => {
    video.status = "deleted";
    const res = await post({ action: "approve", videoId: ID });
    expect(res.status).toBe(404);
    expect(video.status).toBe("deleted");
    expect(writes()).toEqual([]);
  });

  it("approving a pending video also approves its moderation status", async () => {
    const res = await post({ action: "approve", videoId: ID });
    expect(res.status).toBe(200);
    expect(video).toEqual({ status: "ready", moderation_status: "approved" });
    expect(h.audit[0]).toMatchObject({ action: "video.approve", actor: MODERATOR });
  });

  it("refuses to publish a video rejected by moderation", async () => {
    video.moderation_status = "rejected";
    expect((await post({ action: "approve", videoId: ID })).status).toBe(409);
    expect(video.status).toBe("processing");
  });

  it("reject without a reason stores a stable machine code", async () => {
    const res = await post({ action: "reject", videoId: ID });
    expect(res.status).toBe(200);
    const job = h.tx.find((c) => c.sql.includes("INSERT INTO video_processing_jobs"));
    expect(job?.params[2]).toBe("rejected_by_admin");
    expect(video.moderation_status).toBe("rejected");
  });

  it("validates the asset id", async () => {
    expect((await post({ action: "approve", videoId: "not-a-uuid" })).status).toBe(400);
  });
});

describe("orders list pagination is clamped by zod", () => {
  it.each(["-5", "0", "101", "abc"])("limit=%s → 400 (was a 500 from LIMIT -5)", async (limit) => {
    const req = new Request(`http://localhost/api/admin/orders?limit=${limit}`);
    expect((await H(orders.GET)(req, { params: Promise.resolve({}) })).status).toBe(400);
    expect(h.db).toEqual([]);
  });

  it("negative offset → 400; valid values are bound as parameters", async () => {
    const bad = new Request("http://localhost/api/admin/orders?offset=-1");
    expect((await H(orders.GET)(bad, { params: Promise.resolve({}) })).status).toBe(400);
    h.dbHandler = (sql) => (sql.includes("count(*)") ? { rows: [{ count: "0" }], rowCount: 1 } : undefined);
    const ok = new Request("http://localhost/api/admin/orders?limit=20&offset=40");
    expect((await H(orders.GET)(ok, { params: Promise.resolve({}) })).status).toBe(200);
    expect(h.db[0].params).toEqual([20, 40]);
    expect(h.db[0].sql).not.toMatch(/LIMIT \d/);
  });
});

describe("fraud decision", () => {
  it("merges into NULL metadata with COALESCE and returns error codes", async () => {
    h.actor = FINANCE;
    h.dbHandler = (sql) =>
      sql.startsWith("SELECT") ? { rows: [{ id: ID, status: "paid", metadata: null, total_cents: 100, currency: "ron" }], rowCount: 1 } : undefined;
    const res = await call(H(fraudDecision.POST), "POST", { id: ID }, { action: "approve" });
    expect(res.status).toBe(200);
    const upd = h.db.find((c) => c.sql.includes("UPDATE commerce_orders"));
    expect(upd?.sql).toContain("COALESCE(metadata, '{}'::jsonb) ||");
    expect((await (await call(H(fraudDecision.POST), "POST", { id: ID }, { action: "nope" })).json()).error).toBe("invalid_action");
    expect((await (await call(H(fraudDecision.POST), "POST", { id: "-".repeat(36) })).json()).error).toBe("invalid_id");
  });
});

describe("creator applications: conditional state transition", () => {
  let status: string;
  beforeEach(() => {
    status = "submitted";
    h.actor = OPS;
    h.txHandler = (sql) => {
      if (sql.includes("FROM creator_applications")) {
        return { rows: [{ id: ID, user_id: TARGET_USER, status, requested_handle: "h", email: null, username: "u", display_name: null }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE creator_applications")) {
        expect(sql).toContain("status IN ('submitted', 'in_review')");
        if (status !== "submitted" && status !== "in_review") return { rows: [], rowCount: 0 };
        status = sql.includes("'approved'") ? "approved" : "rejected";
        return { rows: [], rowCount: 1 };
      }
      return undefined;
    };
  });

  it("approve → 200, second approve → 409 already_approved, reject after approve → 409", async () => {
    expect((await call(H(applicationApprove.POST), "POST", { id: ID })).status).toBe(200);
    const again = await call(H(applicationApprove.POST), "POST", { id: ID });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_approved");
    const rej = await call(H(applicationReject.POST), "POST", { id: ID }, { reason: "late" });
    expect(rej.status).toBe(409);
    expect(status).toBe("approved");
    expect(h.tx.filter((c) => c.sql.includes("INSERT INTO moderation_actions"))).toHaveLength(1);
    expect(h.notify).toHaveLength(1);
  });

  it("withdrawn applications cannot be decided", async () => {
    status = "withdrawn";
    const res = await call(H(applicationReject.POST), "POST", { id: ID }, { reason: "x" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_decided");
  });
});

describe("moderation reports: already decided → 409", () => {
  it("dismissing an actioned report writes nothing", async () => {
    h.actor = MODERATOR;
    h.txHandler = (sql) =>
      sql.includes("FROM moderation_reports")
        ? {
            rows: [{ id: ID, status: "actioned", reason: "spam", target_video_id: TARGET_VIDEO, target_user_id: null, target_comment_id: null, creator_id: TARGET_USER }],
            rowCount: 1,
          }
        : undefined;
    const res = await call(H(dismissReport.POST), "POST", { id: ID });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("report_already_decided");
    expect(writes()).toEqual([]);
    expect(h.audit).toEqual([]);
  });
});

describe("disputes: bounded payloads", () => {
  it("rejects an evidence object with too many fields", async () => {
    h.actor = FINANCE;
    const evidence = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, "x"]));
    const res = await call(H(disputes.POST), "POST", {}, { disputeId: DP, evidence });
    expect(res.status).toBe(400);
    expect(h.db).toEqual([]);
  });

  it("the suggest query for order items is LIMITed", async () => {
    h.actor = FINANCE;
    h.dbHandler = (sql) => {
      if (sql.includes("FROM stripe_disputes")) return { rows: [{ order_id: ID }], rowCount: 1 };
      if (sql.includes("FROM commerce_orders co")) {
        return { rows: [{ order_id: ID, total_cents: 1, currency: "ron", metadata: null, placed_at: null, buyer_email: null, buyer_username: null, buyer_user_id: null }], rowCount: 1 };
      }
      return undefined;
    };
    const res = await call(H(disputeSuggest.GET), "GET", { disputeId: DP });
    expect(res.status).toBe(200);
    expect(h.db.find((c) => c.sql.includes("FROM commerce_order_items"))?.sql).toMatch(/LIMIT \d+/);
  });
});
