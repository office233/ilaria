import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Like idempotent (lib/social/likes.ts + lib/social/like-route.ts):
 * PUT de două ori = un rând, DELETE pe nimic = no-op, contorul vine din DB
 * (ținut de trigger), anonimii nu emit semnal de ranking și nu notifică.
 */

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  likes: new Set<string>(),
  likeCount: 0,
  interactable: true,
  commentAuthor: "33333333-3333-4333-8333-333333333333" as string | null,
  blocked: false,
  identity: { userId: "11111111-1111-4111-8111-111111111111", isAnon: false } as { userId: string; isAnon: boolean } | null,
  calls: [] as string[],
}));

const dbQuery = vi.hoisted(() =>
  vi.fn(async (sql: string, params: unknown[] = []) => {
    state.calls.push(sql);
    const key = `${params[0]}:${params[1]}`;
    if (sql.startsWith("INSERT INTO likes")) {
      if (state.likes.has(key)) return { rows: [] as Row[], rowCount: 0 };
      state.likes.add(key);
      state.likeCount += 1; // ce face triggerul trg_likes_social_counter
      return { rows: [{ id: "l1" }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM likes")) {
      if (!state.likes.delete(key)) return { rows: [], rowCount: 0 };
      state.likeCount -= 1;
      return { rows: [{ id: "l1" }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT 1 FROM likes")) return { rows: state.likes.has(key) ? [{}] : [], rowCount: 0 };
    if (sql.startsWith("SELECT like_count")) return { rows: [{ like_count: String(state.likeCount) }], rowCount: 1 };
    if (sql.startsWith("SELECT user_id, video_id FROM comments")) {
      return { rows: [{ user_id: state.commentAuthor, video_id: "v" }], rowCount: 1 };
    }
    if (sql.includes("FROM user_blocks")) return { rows: [{ blocked: state.blocked }], rowCount: 1 };
    if (sql.includes("creator_id AS owner")) return { rows: [{ owner: "44444444-4444-4444-8444-444444444444", video_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
);

const notifySocial = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/db", () => ({ dbQuery }));
vi.mock("@/lib/video/interactable", () => ({ isVideoInteractable: async () => state.interactable }));
vi.mock("@/lib/notifications/social", () => ({ notifySocial }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.1.1.1",
}));
const getOrCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/social/session", () => ({
  getOrCreateSocialUser: getOrCreate,
  getSocialIdentity: async () => state.identity,
  getOptionalSocialUserId: async () => state.identity?.userId ?? null,
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));

import { setLike, toggleLike } from "@/lib/social/likes";
import { DELETE as videoUnlike, GET as videoLikeGet, POST as videoLikePost, PUT as videoLike } from "@/app/api/videos/[id]/like/route";
import { PUT as commentLike } from "@/app/api/comments/[id]/like/route";

const USER = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const ctx = (id = VIDEO) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  state.likes.clear();
  state.likeCount = 0;
  state.interactable = true;
  state.blocked = false;
  state.identity = { userId: USER, isAnon: false };
  state.calls = [];
  notifySocial.mockClear();
  getOrCreate.mockReset();
  getOrCreate.mockImplementation(async () => ({ ...(state.identity ?? { userId: USER, isAnon: true }) }));
});

describe("setLike (lib)", () => {
  it("is idempotent: liking twice inserts one row and counts once", async () => {
    const a = await setLike(USER, "video", VIDEO, true);
    const b = await setLike(USER, "video", VIDEO, true);
    expect(a).toEqual({ liked: true, changed: true, likeCount: 1 });
    expect(b).toEqual({ liked: true, changed: false, likeCount: 1 });
  });

  it("unlike of something never liked is a no-op", async () => {
    const r = await setLike(USER, "video", VIDEO, false);
    expect(r).toEqual({ liked: false, changed: false, likeCount: 0 });
  });

  it("never writes like_count itself (the DB trigger owns the counter)", async () => {
    await setLike(USER, "video", VIDEO, true);
    await setLike(USER, "video", VIDEO, false);
    expect(state.calls.some((sql) => /UPDATE\s+(videos|comments)\s+SET\s+like_count/i.test(sql))).toBe(false);
  });

  it("refuses a new like on content that is no longer visible, but always allows unlike", async () => {
    await setLike(USER, "video", VIDEO, true);
    state.interactable = false;
    await expect(setLike("55555555-5555-4555-8555-555555555555", "video", VIDEO, true)).rejects.toMatchObject({ code: "video_not_available" });
    await expect(setLike(USER, "video", VIDEO, false)).resolves.toMatchObject({ changed: true, likeCount: 0 });
  });

  it("refuses liking a comment of a user in a block relationship", async () => {
    state.blocked = true;
    await expect(setLike(USER, "comment", VIDEO, true)).rejects.toMatchObject({ code: "blocked" });
  });

  it("toggleLike flips the current state", async () => {
    expect((await toggleLike(USER, "video", VIDEO)).liked).toBe(true);
    expect((await toggleLike(USER, "video", VIDEO)).liked).toBe(false);
  });
});

describe("like routes", () => {
  it("PUT twice keeps liked=true and the same count; notifies only once", async () => {
    const r1 = await (await videoLike(req("PUT"), ctx())).json();
    const r2 = await (await videoLike(req("PUT"), ctx())).json();
    expect(r1).toMatchObject({ liked: true, like_count: 1 });
    expect(r2).toMatchObject({ liked: true, like_count: 1 });
    expect(notifySocial).toHaveBeenCalledTimes(1);
    expect(state.calls.filter((s) => s.startsWith("INSERT INTO feed_events"))).toHaveLength(1);
  });

  it("POST {liked:false} sets the state instead of toggling", async () => {
    await videoLike(req("PUT"), ctx());
    const r = await (await videoLikePost(req("POST", { liked: false }), ctx())).json();
    const again = await (await videoLikePost(req("POST", { liked: false }), ctx())).json();
    expect(r).toMatchObject({ liked: false, like_count: 0 });
    expect(again).toMatchObject({ liked: false, like_count: 0 });
  });

  it("anonymous likes count but emit no ranking event and no notification", async () => {
    state.identity = { userId: USER, isAnon: true };
    const res = await videoLike(req("PUT"), ctx());
    expect(res.status).toBe(200);
    expect(state.likeCount).toBe(1);
    expect(notifySocial).not.toHaveBeenCalled();
    expect(state.calls.some((s) => s.startsWith("INSERT INTO feed_events"))).toBe(false);
  });

  it("DELETE without any identity does not mint an anonymous user", async () => {
    state.identity = null;
    const res = await videoUnlike(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-uuid id and 404 for unavailable content", async () => {
    expect((await videoLike(req("PUT"), ctx("nope"))).status).toBe(400);
    state.interactable = false;
    expect((await videoLike(req("PUT"), ctx())).status).toBe(404);
  });

  it("returns 403 when liking a comment across a block", async () => {
    state.blocked = true;
    expect((await commentLike(req("PUT"), ctx())).status).toBe(403);
  });

  it("GET reports liked-by-me and the stored count", async () => {
    await videoLike(req("PUT"), ctx());
    const body = await (await videoLikeGet(req("GET"), ctx())).json();
    expect(body).toMatchObject({ liked: true, like_count: 1 });
  });
});
