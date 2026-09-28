import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** Ruta /api/videos/[id]/comments: validare, identitate, moderare, notificări doar pentru conturi. */

const VIDEO = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

const s = vi.hoisted(() => ({
  identity: { userId: "11111111-1111-4111-8111-111111111111", isAnon: false } as { userId: string; isAnon: boolean } | null,
  moderation: { action: "allow" } as { action: string; reasons?: string[]; label?: string },
  feedEvents: 0,
}));

const createComment = vi.hoisted(() => vi.fn());
const deleteComment = vi.hoisted(() => vi.fn());
const notifyForComment = vi.hoisted(() => vi.fn(async () => undefined));
const listComments = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string) => {
    if (sql.includes("feed_events")) s.feedEvents += 1;
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock("@/lib/social/session", () => ({
  getSocialIdentity: async () => s.identity,
  getOrCreateSocialUser: async () => ({ ...(s.identity ?? { userId: USER, isAnon: true }) }),
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.1.1.1",
}));
vi.mock("@/lib/moderation/ai-text", () => ({
  moderateUserText: async () => ({ degraded: false, ai: false, reasons: [], ...s.moderation }),
}));
vi.mock("@/lib/moderation/strikes", () => ({ recordStrike: vi.fn() }));
vi.mock("@/lib/social/comments/mutations", async (orig) => ({
  ...(await orig<typeof import("@/lib/social/comments/mutations")>()),
  createComment,
  deleteComment,
}));
vi.mock("@/lib/social/comments/notify", () => ({ notifyForComment }));
vi.mock("@/lib/social/comments/queries", () => ({
  getVideoCommentMeta: async () => ({ ownerId: USER, commentCount: 7, allowComments: true }),
  listComments,
  listReplies: vi.fn(),
}));

import { DELETE, GET, POST } from "@/app/api/videos/[id]/comments/route";
import { CommentError } from "@/lib/social/comments/mutations";

const ctx = (id = VIDEO) => ({ params: Promise.resolve({ id }) });
const req = (url: string, init?: RequestInit) => new NextRequest(new URL(url, "http://localhost"), init as never);
const post = (body: unknown) =>
  POST(req(`/api/videos/${VIDEO}/comments`, { method: "POST", body: JSON.stringify(body) }), ctx());

beforeEach(() => {
  s.identity = { userId: USER, isAnon: false };
  s.moderation = { action: "allow" };
  s.feedEvents = 0;
  createComment.mockReset();
  createComment.mockResolvedValue({
    comment: { id: "c1", parentCommentId: null },
    videoOwnerId: USER,
    parentAuthorId: null,
    commentCount: 8,
  });
  notifyForComment.mockClear();
  listComments.mockReset();
});

describe("GET", () => {
  it("rejects bad ids and bad cursors with 400", async () => {
    expect((await GET(req("/x"), ctx("nope"))).status).toBe(400);
    expect((await GET(req(`/x?cursor=garbage`), ctx())).status).toBe(400);
  });

  it("returns the page plus viewer flags", async () => {
    listComments.mockResolvedValue({ pinned: null, comments: [], nextCursor: null, totalCount: 7 });
    const body = await (await GET(req("/x"), ctx())).json();
    expect(body).toMatchObject({ totalCount: 7, hasMore: false, viewer: { id: USER, isAccount: true, isVideoOwner: true } });
  });
});

describe("POST", () => {
  it("validates text before touching identity", async () => {
    const res = await post({ text: "   " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "comment_text_required" });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("returns a stable code when moderation rejects", async () => {
    s.moderation = { action: "reject", reasons: ["x"], label: "blocked" };
    const res = await post({ text: "ceva" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("comment_rejected");
  });

  it("a comment hidden by the AI (or held because it was unavailable) opens a moderation case, no ranking event", async () => {
    const { dbQuery } = await import("@/lib/db");
    vi.mocked(dbQuery).mockClear();
    s.moderation = { action: "hide", reasons: ["moderation_unavailable"], label: "safe", ai: true, degraded: true } as typeof s.moderation;
    const res = await post({ text: "ceva" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ moderation_status: "hidden" });
    const caseCall = vi.mocked(dbQuery).mock.calls.find(([sql]) => String(sql).includes("moderation_cases"));
    expect(String(caseCall?.[0])).toContain("target_comment_id");
    expect(caseCall?.[1]).toEqual(expect.arrayContaining(["c1", "low"]));
    expect(s.feedEvents).toBe(0);
  });

  it("an account comment returns the real count, records a ranking event and notifies", async () => {
    const res = await post({ text: "salut @ana" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ comment_count: 8, moderation_status: "visible" });
    expect(s.feedEvents).toBe(1);
    expect(notifyForComment).toHaveBeenCalledWith(expect.objectContaining({ actor: { userId: USER, isAnon: false } }));
  });

  it("an anonymous comment records no ranking event (notify gets isAnon=true and skips)", async () => {
    s.identity = { userId: USER, isAnon: true };
    await post({ text: "salut" });
    expect(s.feedEvents).toBe(0);
    expect(notifyForComment).toHaveBeenCalledWith(expect.objectContaining({ actor: { userId: USER, isAnon: true } }));
  });

  it("maps domain errors (blocked, disabled) to their status", async () => {
    createComment.mockRejectedValueOnce(new CommentError("blocked", 403));
    expect((await post({ text: "a" })).status).toBe(403);
    createComment.mockRejectedValueOnce(new CommentError("comments_disabled", 403));
    expect((await (await post({ text: "a" })).json()).error).toBe("comments_disabled");
  });
});

describe("DELETE", () => {
  it("requires an identity and valid ids", async () => {
    expect((await DELETE(req(`/x?comment_id=bad`), ctx())).status).toBe(400);
    s.identity = null;
    expect((await DELETE(req(`/x?comment_id=${VIDEO}`), ctx())).status).toBe(401);
  });

  it("forwards permission errors from the domain layer", async () => {
    deleteComment.mockRejectedValueOnce(new CommentError("forbidden", 403));
    expect((await DELETE(req(`/x?comment_id=${VIDEO}`), ctx())).status).toBe(403);
    deleteComment.mockResolvedValueOnce({ commentCount: 2, videoId: VIDEO });
    expect(await (await DELETE(req(`/x?comment_id=${VIDEO}`), ctx())).json()).toEqual({ success: true, comment_count: 2 });
  });
});
