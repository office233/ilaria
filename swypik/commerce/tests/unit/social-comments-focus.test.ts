import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** `?focus=<commentId>` pe GET /api/videos/[id]/comments: firul comentariului țintă (deep link din notificări). */

const VIDEO = "22222222-2222-4222-8222-222222222222";
const TOP = "33333333-3333-4333-8333-333333333333";
const REPLY = "44444444-4444-4444-8444-444444444444";
const OWNER = "11111111-1111-4111-8111-111111111111";
const R1 = "55555555-5555-4555-8555-555555555551";
const R2 = "55555555-5555-4555-8555-555555555552";

type Row = Record<string, unknown>;
const rows = vi.hoisted(() => ({ byId: new Map<string, Row>(), inline: [] as Row[], sql: [] as string[] }));

vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[]) => {
    rows.sql.push(sql);
    if (sql.includes("WHERE c.id = $2 AND c.video_id = $3")) {
      const r = rows.byId.get(String(params[1]));
      return { rows: r && r.video_id === params[2] ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (sql.includes("reply_rank")) return { rows: rows.inline, rowCount: rows.inline.length };
    if (sql.includes("FROM videos WHERE id")) return { rows: [{ creator_id: OWNER, comment_count: 5, allow_comments: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock("@/lib/social/session", () => ({
  getSocialIdentity: async () => null,
  getOrCreateSocialUser: vi.fn(),
  setAnonSessionCookie: () => undefined,
  anonSessionErrorResponse: () => null,
}));
vi.mock("@/lib/social/blocks", () => ({ notBlockedSql: () => "TRUE" }));

import { getFocusedThread } from "@/lib/social/comments/focus";
import { GET } from "@/app/api/videos/[id]/comments/route";

const meta = { ownerId: OWNER, commentCount: 5, allowComments: true };
const viewer = { viewerId: null, viewerIsAccount: false, locale: "ro" as const };
const row = (id: string, parent: string | null, at: string, over: Row = {}): Row => ({
  id, video_id: VIDEO, user_id: null, parent_comment_id: parent, body: id, status: "visible",
  like_count: 0, reply_count: 0, created_at: at, pinned_at: null, viewer_liked: false,
  username: null, display_name: "x", avatar_url: null, ...over,
});

beforeEach(() => {
  rows.byId.clear();
  rows.inline = [];
  rows.sql = [];
});

describe("getFocusedThread", () => {
  it("un comentariu de nivel 1 → firul lui cu răspunsurile inline", async () => {
    rows.byId.set(TOP, row(TOP, null, "2026-09-20T00:00:00Z", { reply_count: 1 }));
    rows.inline = [row(R1, TOP, "2026-09-21T00:00:00Z")];
    const thread = await getFocusedThread(VIDEO, TOP, meta, viewer);
    expect(thread?.id).toBe(TOP);
    expect(thread?.replies.map((r) => r.id)).toEqual([R1]);
  });

  it("un răspuns → firul părintelui, cu răspunsul țintă garantat prezent", async () => {
    rows.byId.set(TOP, row(TOP, null, "2026-09-20T00:00:00Z", { reply_count: 9 }));
    rows.byId.set(REPLY, row(REPLY, TOP, "2026-09-24T00:00:00Z"));
    rows.inline = [row(R1, TOP, "2026-09-21T00:00:00Z"), row(R2, TOP, "2026-09-22T00:00:00Z")];
    const thread = await getFocusedThread(VIDEO, REPLY, meta, viewer);
    expect(thread?.id).toBe(TOP);
    expect(thread?.replies.map((r) => r.id)).toEqual([R1, R2, REPLY]);
    // cursorul „vezi mai multe" pornește după ultimul răspuns consecutiv, nu după țintă
    expect(thread?.repliesCursor).not.toBeNull();
  });

  it("comentariu invizibil / de pe alt clip → null", async () => {
    expect(await getFocusedThread(VIDEO, TOP, meta, viewer)).toBeNull();
    rows.byId.set(TOP, { ...row(TOP, null, "2026-09-20T00:00:00Z"), video_id: OWNER });
    expect(await getFocusedThread(VIDEO, TOP, meta, viewer)).toBeNull();
  });
});

describe("GET ?focus=", () => {
  const req = (qs: string) => new NextRequest(new URL(`/api/videos/${VIDEO}/comments${qs}`, "http://localhost"));
  const ctx = { params: Promise.resolve({ id: VIDEO }) };

  it("prima pagină include `focused`", async () => {
    rows.byId.set(TOP, row(TOP, null, "2026-09-20T00:00:00Z"));
    const body = await (await GET(req(`?focus=${TOP}`), ctx)).json();
    expect(body.focused?.id).toBe(TOP);
  });

  it("id invalid sau pagină ulterioară → ignorat (fără interogare)", async () => {
    const bad = await (await GET(req(`?focus=nope`), ctx)).json();
    expect(bad.focused).toBeNull();
    expect(rows.sql.some((s) => s.includes("WHERE c.id = $2 AND c.video_id = $3"))).toBe(false);
  });
});
