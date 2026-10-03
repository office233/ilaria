import { describe, it, expect, vi, beforeEach } from "vitest";

let identity: { userId: string; isAnon: boolean } = { userId: "11111111-1111-4111-8111-111111111111", isAnon: true };
const { notify, dbQuery } = vi.hoisted(() => ({
  notify: vi.fn(async () => undefined),
  dbQuery: vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 })),
}));

vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: async () => identity.userId,
  getSocialIdentity: async () => identity,
  getOrCreateSocialUser: async () => ({ ...identity }),
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notifyUser: notify }));
// Notificările sociale trec prin notifySocial (regula anonimilor e testată în social-notify.test.ts).
vi.mock("@/lib/notifications/social", () => ({ notifySocial: notify }));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 1 }),
  getClientIP: () => "1.1.1.1",
}));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: async () => null }));

const clientQuery = vi.fn(async (sql: string) => {
  if (sql.startsWith("SELECT id FROM follows")) return { rows: [] };
  if (sql.startsWith("INSERT INTO follows")) return { rows: [{ id: "f1" }] };
  if (sql.startsWith("SELECT COUNT")) return { rows: [{ count: "1" }] };
  return { rows: [] };
});
vi.mock("@/lib/db", () => ({
  dbQuery,
  getDb: () => ({ connect: async () => ({ query: clientQuery, release: () => undefined }) }),
}));

import { PUT as follow, GET as followGet } from "@/app/api/users/[id]/follow/route";
import { GET as commentLikeGet } from "@/app/api/comments/[id]/like/route";
import { GET as liveList } from "@/app/api/live/streams/route";
import { withErrorHandling } from "@/lib/api-handler";
import { isBigintIdParam, isUuidParam } from "@/lib/validation/params";

const TARGET = "22222222-2222-4222-8222-222222222222";
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url = "http://localhost/x", method = "POST") => new Request(url, { method });

beforeEach(() => {
  notify.mockClear();
  dbQuery.mockReset();
  dbQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  identity = { userId: "11111111-1111-4111-8111-111111111111", isAnon: true };
});

describe("follow route", () => {
  it("returns 400 for a non-uuid id (POST and GET)", async () => {
    expect((await follow(req(), p("not-a-uuid"))).status).toBe(400);
    expect((await followGet(req("http://localhost/x", "GET"), p("not-a-uuid"))).status).toBe(400);
  });

  it("returns 404 when the target user does not exist", async () => {
    const res = await follow(req(), p(TARGET));
    expect(res.status).toBe(404);
  });

  it("does not notify when the follower is anonymous", async () => {
    dbQuery.mockImplementation(async (sql: string) =>
      sql.includes("user_blocks") ? { rows: [{ blocked: false }], rowCount: 1 } : { rows: [{ "?column?": 1 }], rowCount: 1 });
    const res = await follow(req(), p(TARGET));
    expect(res.status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies when the follower has a real account", async () => {
    identity = { ...identity, isAnon: false };
    dbQuery.mockImplementation(async (sql: string) =>
      sql.includes("user_blocks") ? { rows: [{ blocked: false }], rowCount: 1 } : { rows: [{ "?column?": 1 }], rowCount: 1 });
    const res = await follow(req(), p(TARGET));
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("comment like GET", () => {
  it("returns 400 for a non-uuid id", async () => {
    const res = await commentLikeGet(req("http://localhost/x", "GET"), p("nope"));
    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe("live streams list", () => {
  it("rejects a non-numeric limit and an unknown status with 400", async () => {
    const r1 = await liveList(new Request("http://localhost/api/live/streams?limit=abc") as never);
    expect(r1.status).toBe(400);
    const r2 = await liveList(new Request("http://localhost/api/live/streams?status=bogus") as never);
    expect(r2.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("uses defaults for a valid request", async () => {
    const res = await liveList(new Request("http://localhost/api/live/streams") as never);
    expect(res.status).toBe(200);
    expect(dbQuery.mock.calls[0][1]).toEqual(["live", 20, 0]);
  });
});

describe("withErrorHandling safety net", () => {
  it("maps Postgres invalid-input errors to 400", async () => {
    const h = withErrorHandling(async () => {
      throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    });
    const res = await h();
    expect(res.status).toBe(400);
  });
});

describe("param helpers", () => {
  it("validates uuid and bigint ids", () => {
    expect(isUuidParam(TARGET)).toBe(true);
    expect(isUuidParam("abc")).toBe(false);
    expect(isBigintIdParam("42")).toBe(true);
    expect(isBigintIdParam("0")).toBe(false);
    expect(isBigintIdParam("99999999999999999999")).toBe(false);
  });
});
