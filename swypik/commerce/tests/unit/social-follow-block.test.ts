import { beforeEach, describe, expect, it, vi } from "vitest";

/** Follow idempotent + blocări (lib/social/follows.ts, blocks.ts, rutele follow/block, notifySocial). */

type Row = Record<string, unknown>;
const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

const s = vi.hoisted(() => ({
  follows: new Set<string>(),
  blocks: new Set<string>(),
  userExists: true,
  identity: { userId: "11111111-1111-4111-8111-111111111111", isAnon: false } as { userId: string; isAnon: boolean } | null,
  account: "11111111-1111-4111-8111-111111111111" as string | null,
  tx: [] as string[],
}));

function blockedEither(a: unknown, b: unknown) {
  return s.blocks.has(`${a}>${b}`) || s.blocks.has(`${b}>${a}`);
}

const dbQuery = vi.hoisted(() =>
  vi.fn(async (sql: string, p: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
    const out = (rows: Row[]) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("INSERT INTO follows")) {
      const k = `${p[0]}>${p[1]}`;
      if (s.follows.has(k)) return out([]);
      s.follows.add(k);
      return out([{ id: "f" }]);
    }
    if (sql.startsWith("DELETE FROM follows")) return out(s.follows.delete(`${p[0]}>${p[1]}`) ? [{ id: "f" }] : []);
    if (sql.startsWith("SELECT 1 FROM follows")) return out(s.follows.has(`${p[0]}>${p[1]}`) ? [{}] : []);
    if (sql.includes("COUNT(*)::text AS count FROM follows")) {
      return out([{ count: String([...s.follows].filter((k) => k.endsWith(`>${p[0]}`)).length) }]);
    }
    if (sql.includes("FROM users WHERE id = $1")) return out(s.userExists ? [{}] : []);
    if (sql.includes("SELECT EXISTS") && sql.includes("user_blocks")) return out([{ blocked: blockedEither(p[0], p[1]) }]);
    if (sql.startsWith("SELECT blocker_user_id FROM user_blocks")) {
      return out([...s.blocks].filter((k) => k === `${p[0]}>${p[1]}` || k === `${p[1]}>${p[0]}`).map((k) => ({ blocker_user_id: k.split(">")[0] })));
    }
    if (sql.startsWith("DELETE FROM user_blocks")) {
      s.blocks.delete(`${p[0]}>${p[1]}`);
      return out([]);
    }
    return out([]);
  }),
);

vi.mock("@/lib/db", () => ({
  dbQuery,
  withTransaction: vi.fn(async (fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => unknown) =>
    fn(async (sql: string, p: unknown[] = []) => {
      s.tx.push(sql);
      if (sql.startsWith("INSERT INTO user_blocks")) s.blocks.add(`${p[0]}>${p[1]}`);
      if (sql.startsWith("DELETE FROM follows")) {
        s.follows.delete(`${p[0]}>${p[1]}`);
        s.follows.delete(`${p[1]}>${p[0]}`);
      }
      return { rows: [], rowCount: 0 };
    }),
  ),
}));
const notifySocial = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/notifications/social", () => ({ notifySocial }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.1.1.1",
}));
vi.mock("@/lib/social/session", () => ({
  getOrCreateSocialUser: async () => ({ ...(s.identity as { userId: string; isAnon: boolean }) }),
  getSocialIdentity: async () => s.identity,
  getOptionalSocialUserId: async () => s.identity?.userId ?? null,
  getAccountUserId: async () => s.account,
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));

import { setFollow } from "@/lib/social/follows";
import { DELETE as unfollow, POST as followPost, PUT as follow } from "@/app/api/users/[id]/follow/route";
import { DELETE as unblock, GET as blockGet, PUT as block } from "@/app/api/users/[id]/block/route";

const ctx = (id = THEM) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  s.follows.clear();
  s.blocks.clear();
  s.userExists = true;
  s.identity = { userId: ME, isAnon: false };
  s.account = ME;
  s.tx = [];
  notifySocial.mockClear();
});

describe("follow", () => {
  it("setFollow is idempotent and the count is live", async () => {
    expect(await setFollow(ME, THEM, true)).toEqual({ following: true, changed: true, followerCount: 1 });
    expect(await setFollow(ME, THEM, true)).toEqual({ following: true, changed: false, followerCount: 1 });
    expect(await setFollow(ME, THEM, false)).toEqual({ following: false, changed: true, followerCount: 0 });
    expect(await setFollow(ME, THEM, false)).toEqual({ following: false, changed: false, followerCount: 0 });
  });

  it("cannot follow yourself or a missing user", async () => {
    await expect(setFollow(ME, ME, true)).rejects.toMatchObject({ code: "cannot_follow_self" });
    s.userExists = false;
    await expect(setFollow(ME, THEM, true)).rejects.toMatchObject({ code: "user_not_found" });
  });

  it("PUT twice notifies once; DELETE unfollows; POST {following} sets", async () => {
    expect(await (await follow(req("PUT"), ctx())).json()).toEqual({ following: true, follower_count: 1 });
    expect(await (await follow(req("PUT"), ctx())).json()).toEqual({ following: true, follower_count: 1 });
    expect(notifySocial).toHaveBeenCalledTimes(1);
    expect(notifySocial).toHaveBeenCalledWith(expect.objectContaining({ notice: "follow", recipientId: THEM }));
    expect(await (await unfollow(req("DELETE"), ctx())).json()).toEqual({ following: false, follower_count: 0 });
    expect(await (await followPost(req("POST", { following: true }), ctx())).json()).toMatchObject({ following: true });
  });

  it("anonymous follows count but do not notify", async () => {
    s.identity = { userId: ME, isAnon: true };
    expect((await follow(req("PUT"), ctx())).status).toBe(200);
    expect(notifySocial).not.toHaveBeenCalled();
  });

  it("returns 400 for bad ids / self and 403 across a block", async () => {
    expect((await follow(req("PUT"), ctx("nope"))).status).toBe(400);
    expect((await follow(req("PUT"), ctx(ME))).status).toBe(400);
    s.blocks.add(`${THEM}>${ME}`);
    expect((await follow(req("PUT"), ctx())).status).toBe(403);
  });
});

describe("block", () => {
  it("requires a real account and refuses self-blocks", async () => {
    s.account = null;
    expect((await block(req("PUT"), ctx())).status).toBe(401);
    s.account = ME;
    expect((await block(req("PUT"), ctx(ME))).status).toBe(400);
  });

  it("blocking removes follows both ways and prevents re-following", async () => {
    s.follows.add(`${ME}>${THEM}`);
    s.follows.add(`${THEM}>${ME}`);
    const res = await block(req("PUT"), ctx());
    expect(await res.json()).toEqual({ blocked_by_me: true });
    expect(s.follows.size).toBe(0);
    expect(await (await blockGet(req("GET"), ctx())).json()).toEqual({ blocked_by_me: true, blocks_me: false });
    expect((await follow(req("PUT"), ctx())).status).toBe(403);
  });

  it("unblock lifts the restriction", async () => {
    await block(req("PUT"), ctx());
    await unblock(req("DELETE"), ctx());
    expect((await follow(req("PUT"), ctx())).status).toBe(200);
  });

  it("blocking a missing user → 404", async () => {
    s.userExists = false;
    expect((await block(req("PUT"), ctx())).status).toBe(404);
  });
});
