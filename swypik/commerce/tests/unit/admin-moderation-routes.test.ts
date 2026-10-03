/**
 * Moderare în consola de admin: cele 4 decizii pe rapoarte + aprobarea/
 * respingerea clipurilor (în așteptare / semnalate). Auth, RBAC, tranzacție, audit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminActor } from "@/lib/security/admin-auth";
import {
  auditInserts,
  FINANCE,
  idParams,
  jsonReq,
  MODERATOR,
  TARGET_REPORT,
  TARGET_USER,
  TARGET_VIDEO,
  type SqlCall,
} from "./helpers/admin-actors";

const h = vi.hoisted(() => ({
  actor: null as AdminActor | null,
  db: [] as { sql: string; params: unknown[] }[],
  tx: [] as { sql: string; params: unknown[] }[],
  txResponses: [] as { rows: unknown[]; rowCount?: number }[],
  notify: [] as unknown[][],
  fanout: [] as unknown[][],
}));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.db.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }),
  withTransaction: async (fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<unknown>) =>
    fn(async (sql: string, params: unknown[] = []) => {
      h.tx.push({ sql, params });
      return h.txResponses.shift() ?? { rows: [{ id: "case-1" }], rowCount: 1 };
    }),
}));
vi.mock("@/lib/security/admin-auth", () => ({
  getAdminActorFromRequest: async () => h.actor,
  getAdminActor: async () => h.actor,
  revokeAdminSessionsForUser: async (id: string, q: (s: string, p: unknown[]) => Promise<unknown>) =>
    q("UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1", [id]),
}));
vi.mock("@/lib/notifications/localized", () => ({
  notifyLocalized: async (...a: unknown[]) => void h.notify.push(a),
}));
vi.mock("@/lib/notifications/dispatch", () => ({
  notifyFollowersNewPost: async (...a: unknown[]) => {
    h.fanout.push(a);
    return 0;
  },
}));
vi.mock("@/lib/video/publish-notify", () => ({
  notifyFollowersOnce: async (...a: unknown[]) => {
    h.fanout.push(a);
    return true;
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as dismiss } from "@/app/api/admin/moderation/[id]/dismiss/route";
import { POST as hideVideo } from "@/app/api/admin/moderation/[id]/hide-video/route";
import { POST as deleteVideo } from "@/app/api/admin/moderation/[id]/delete-video/route";
import { POST as banCreator } from "@/app/api/admin/moderation/[id]/ban-creator/route";
import { POST as decideVideo } from "@/app/api/admin/moderation/videos/[id]/route";

const REPORT_ROW = {
  id: TARGET_REPORT,
  status: "open",
  reason: "spam",
  target_video_id: TARGET_VIDEO,
  target_user_id: null,
  target_comment_id: null,
  creator_id: TARGET_USER,
};
const audit = () => auditInserts(h.db as SqlCall[]);
const txSql = () => h.tx.map((c) => c.sql).join("\n");
const reportReq = (action: string, note?: string) =>
  jsonReq(`/api/admin/moderation/${TARGET_REPORT}/${action}`, note ? { note } : {});
const videoReq = (body: unknown) => jsonReq(`/api/admin/moderation/videos/${TARGET_VIDEO}`, body);

beforeEach(() => {
  h.actor = MODERATOR;
  h.db = [];
  h.tx = [];
  h.txResponses = [];
  h.notify = [];
  h.fanout = [];
});

const reportRoutes = [
  ["dismiss", dismiss, "moderation.dismiss", "moderation_report", TARGET_REPORT],
  ["hide-video", hideVideo, "moderation.hide_video", "video", TARGET_VIDEO],
  ["delete-video", deleteVideo, "moderation.delete_video", "video", TARGET_VIDEO],
  ["ban-creator", banCreator, "moderation.ban_creator", "user", TARGET_USER],
] as const;

describe("report decisions", () => {
  it.each(reportRoutes)("%s → 401 without session, 403 for a finance admin", async (action, handler) => {
    h.actor = null;
    expect((await handler(reportReq(action), idParams(TARGET_REPORT))).status).toBe(401);
    h.actor = FINANCE;
    expect((await handler(reportReq(action), idParams(TARGET_REPORT))).status).toBe(403);
    expect(h.tx).toHaveLength(0);
    expect(audit()).toHaveLength(0);
  });

  it.each(reportRoutes)("%s → applies in one transaction and audits the named moderator", async (action, handler, verb, type, target) => {
    h.txResponses = [{ rows: [REPORT_ROW] }];
    const res = await handler(reportReq(action, "confirmed"), idParams(TARGET_REPORT));
    expect(res.status).toBe(200);
    expect(h.tx[0].sql).toContain("FOR UPDATE");
    expect(txSql()).toContain("INSERT INTO moderation_cases");
    expect(txSql()).toContain("INSERT INTO moderation_actions");
    const row = audit()[0];
    expect(row.slice(0, 6)).toEqual([MODERATOR.userId, "admin_user", "moderator", verb, type, target]);
    expect(JSON.parse(String(row[6]))).toMatchObject({ reportId: TARGET_REPORT, note: "confirmed" });
  });

  it("ban-creator suspends, revokes sessions and notifies the creator", async () => {
    h.txResponses = [{ rows: [REPORT_ROW] }];
    await banCreator(reportReq("ban-creator"), idParams(TARGET_REPORT));
    expect(txSql()).toContain("suspended_until");
    expect(txSql()).toContain("UPDATE user_sessions SET revoked_at");
    expect(txSql()).toContain("UPDATE admin_sessions");
    expect(h.notify[0]?.slice(0, 2)).toEqual([TARGET_USER, "accountSuspended"]);
  });

  it("ban-creator refuses an admin creator", async () => {
    h.txResponses = [{ rows: [REPORT_ROW] }, { rows: [], rowCount: 0 }];
    const res = await banCreator(reportReq("ban-creator"), idParams(TARGET_REPORT));
    expect(res.status).toBe(400);
    expect(audit()).toHaveLength(0);
  });

  it("404 for a missing report; hide on a report without video → 404", async () => {
    h.txResponses = [{ rows: [] }];
    expect((await dismiss(reportReq("dismiss"), idParams(TARGET_REPORT))).status).toBe(404);
    h.txResponses = [{ rows: [{ ...REPORT_ROW, target_video_id: null, target_user_id: TARGET_USER }] }];
    expect((await (await hideVideo(reportReq("hide-video"), idParams(TARGET_REPORT))).json()).error).toBe(
      "report_invalid_no_video",
    );
    expect(audit()).toHaveLength(0);
  });

  it("dismissing a comment report targets the comment (exactly one case target)", async () => {
    const comment = "44444444-4444-4444-8444-444444444444";
    h.txResponses = [{ rows: [{ ...REPORT_ROW, target_video_id: null, target_comment_id: comment, creator_id: null }] }];
    await dismiss(reportReq("dismiss"), idParams(TARGET_REPORT));
    const caseInsert = h.tx.find((c) => c.sql.includes("INSERT INTO moderation_cases"));
    expect(caseInsert?.params.slice(1, 4)).toEqual([null, null, comment]);
  });
});

describe("video decisions (pending / flagged)", () => {
  it("401 / 403 / invalid id / reject without reason", async () => {
    h.actor = null;
    expect((await decideVideo(videoReq({ decision: "approve" }), idParams(TARGET_VIDEO))).status).toBe(401);
    h.actor = FINANCE;
    expect((await decideVideo(videoReq({ decision: "approve" }), idParams(TARGET_VIDEO))).status).toBe(403);
    h.actor = MODERATOR;
    expect((await decideVideo(videoReq({ decision: "approve" }), idParams("nope"))).status).toBe(400);
    const noReason = await decideVideo(videoReq({ decision: "reject" }), idParams(TARGET_VIDEO));
    expect((await noReason.json()).error).toBe("reason_required");
    expect(audit()).toHaveLength(0);
  });

  it("approving a pending clip unlocks it for the feed (keeps creator's visibility), closes cases, fans out once and audits", async () => {
    h.txResponses = [
      { rows: [{ id: TARGET_VIDEO, creator_id: TARGET_USER, title: "Clip", moderation_status: "pending_review" }] },
      { rows: [{ c: 1 }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ];
    const res = await decideVideo(videoReq({ decision: "approve" }), idParams(TARGET_VIDEO));
    expect(await res.json()).toMatchObject({ ok: true, published: true });
    expect(txSql()).toContain("moderation_status = 'approved'");
    // Aprobarea nu publică draft-uri/programate — visibility rămâne a creatorului.
    expect(txSql()).not.toContain("visibility = 'public'");
    expect(txSql()).toContain("UPDATE moderation_cases");
    expect(audit()[0].slice(0, 6)).toEqual([
      MODERATOR.userId, "admin_user", "moderator", "video.moderation_approve", "video", TARGET_VIDEO,
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fanout).toEqual([[TARGET_VIDEO]]);
  });

  it("rejecting a flagged (already approved) clip hides it and notifies the creator", async () => {
    h.txResponses = [
      { rows: [{ id: TARGET_VIDEO, creator_id: TARGET_USER, title: null, moderation_status: "approved" }] },
      { rows: [{ c: 2 }] },
    ];
    const res = await decideVideo(videoReq({ decision: "reject", reason: "nuditate" }), idParams(TARGET_VIDEO));
    expect(res.status).toBe(200);
    expect(txSql()).toContain("moderation_status = 'rejected'");
    expect(h.notify[0]?.slice(0, 2)).toEqual([TARGET_USER, "videoRejected"]);
    expect(audit()[0][3]).toBe("video.moderation_reject");
  });

  it("409 when there is nothing left to decide, 404 when the clip is gone", async () => {
    h.txResponses = [
      { rows: [{ id: TARGET_VIDEO, creator_id: null, title: null, moderation_status: "approved" }] },
      { rows: [{ c: 0 }] },
    ];
    expect((await decideVideo(videoReq({ decision: "approve" }), idParams(TARGET_VIDEO))).status).toBe(409);
    h.txResponses = [{ rows: [] }];
    expect((await decideVideo(videoReq({ decision: "approve" }), idParams(TARGET_VIDEO))).status).toBe(404);
    expect(audit()).toHaveLength(0);
  });
});
