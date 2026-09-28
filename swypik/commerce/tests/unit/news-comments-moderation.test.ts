import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111" as string | null,
  verdict: { flagged: false, reasons: [] as string[], decision: "allow", maxSeverity: 0 },
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  author: "22222222-2222-4222-8222-222222222222",
  blocks: [] as Array<[string, string]>,
}));

vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response(null, { status: 410 }) }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => ({ userId: h.userId }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/ai/moderate", () => ({ moderate: async () => h.verdict }));
vi.mock("@/lib/social/blocks", () => ({
  notBlockedSql: (a: string, v: string) => `NOT_BLOCKED(${a},${v})`,
  blockUser: async (a: string, b: string) => void h.blocks.push([a, b]),
}));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.queries.push({ sql, params });
    if (sql.includes("FROM news_articles WHERE slug")) return { rows: [{ id: "art-1" }], rowCount: 1 };
    if (sql.includes("INSERT INTO news_comments")) return { rows: [{ id: "c-new", created_at: "t" }], rowCount: 1 };
    if (sql.includes("SELECT user_id, content FROM news_comments")) return { rows: [{ user_id: h.author, content: "text" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

import { GET, POST } from "@/app/api/news/[slug]/comments/route";
import { POST as report } from "@/app/api/news/[slug]/comments/[id]/report/route";
import { POST as block } from "@/app/api/news/[slug]/comments/[id]/block/route";

const CID = "33333333-3333-4333-8333-333333333333";
const slugCtx = { params: Promise.resolve({ slug: "a" }) };
const idCtx = { params: Promise.resolve({ slug: "a", id: CID }) };
const create = (content: string) =>
  POST(new Request("http://x/api/news/a/comments", { method: "POST", body: JSON.stringify({ content }) }) as never, slugCtx);

beforeEach(() => {
  h.userId = "11111111-1111-4111-8111-111111111111";
  h.verdict = { flagged: false, reasons: [], decision: "allow", maxSeverity: 0 };
  h.queries = [];
  h.author = "22222222-2222-4222-8222-222222222222";
  h.blocks = [];
});

describe("comentarii la știri — Content Safety", () => {
  it("curat → publicat (201)", async () => {
    const res = await create("Foarte bun articol");
    expect(res.status).toBe(201);
    expect(h.queries.find((q) => q.sql.includes("INSERT INTO news_comments"))?.params[4]).toBe("published");
  });
  it("review → salvat 'moderated' (ascuns), 202 pending", async () => {
    h.verdict = { flagged: true, reasons: ["violence:3"], decision: "review", maxSeverity: 3 };
    const res = await create("text");
    expect(res.status).toBe(202);
    expect((await res.json()).pending).toBe(true);
    expect(h.queries.find((q) => q.sql.includes("INSERT INTO news_comments"))?.params[4]).toBe("moderated");
  });
  it("block → 422 comment_blocked, nimic inserat", async () => {
    h.verdict = { flagged: true, reasons: ["hate:6"], decision: "block", maxSeverity: 6 };
    const res = await create("text");
    expect(res.status).toBe(422);
    expect(h.queries.some((q) => q.sql.includes("INSERT INTO news_comments"))).toBe(false);
  });
  it("GET ascunde autorii blocați și nu expune user_id", async () => {
    await GET(new Request("http://x/api/news/a/comments") as never, slugCtx);
    const list = h.queries.find((q) => q.sql.includes("FROM news_comments c"));
    expect(list?.sql).toContain("NOT_BLOCKED(c.user_id,$4)");
    expect(list?.params[3]).toBe(h.userId);
  });
});

describe("raport + blocare autor", () => {
  it("raport → moderation_reports (autor găsit pe server)", async () => {
    const res = await report(new Request("http://x", { method: "POST", body: JSON.stringify({ reason: "spam" }) }), idCtx);
    expect(res.status).toBe(201);
    const ins = h.queries.find((q) => q.sql.includes("INSERT INTO moderation_reports"));
    expect(ins?.params.slice(0, 3)).toEqual([h.userId, h.author, "spam"]);
  });
  it("blocare → user_blocks; propriul comentariu → 422", async () => {
    expect((await block(new Request("http://x", { method: "POST" }), idCtx)).status).toBe(200);
    expect(h.blocks).toEqual([[h.userId, h.author]]);
    h.author = h.userId as string;
    expect((await block(new Request("http://x", { method: "POST" }), idCtx)).status).toBe(422);
  });
  it("fără cont → 401", async () => {
    h.userId = null;
    expect((await block(new Request("http://x", { method: "POST" }), idCtx)).status).toBe(401);
  });
});
