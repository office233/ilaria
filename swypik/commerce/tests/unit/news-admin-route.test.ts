import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

let isAdmin = true;
const audit: unknown[] = [];
const articles = new Map<string, { status: string; sources: number }>();
const ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response(null, { status: 410 }) }));
vi.mock("@/lib/admin/guard", () => ({
  requireAdmin: async () => (isAdmin ? { userId: "admin-1", role: "owner", kind: "admin_user" } : NextResponse.json({ error: "forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/security/admin-audit", () => ({ logAdminAction: async (e: unknown) => { audit.push(e); } }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, p: unknown[] = []) => {
    const a = articles.get(String(p[0]));
    if (sql.includes("count(*)::int AS n FROM news_article_sources")) return { rows: [{ n: a?.sources ?? 0 }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM news_articles")) return { rows: a ? [{}] : [], rowCount: a ? 1 : 0 };
    if (sql.includes("UPDATE news_articles")) {
      if (!a) return { rows: [], rowCount: 0 };
      a.status = String(p[1]);
      return { rows: [{ id: p[0], status: a.status }], rowCount: 1 };
    }
    if (sql.includes("FROM news_articles a")) return { rows: [{ id: ID, status: p[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

import { GET } from "@/app/api/admin/news/route";
import { PATCH } from "@/app/api/admin/news/[id]/route";

const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/admin/news/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  isAdmin = true;
  audit.length = 0;
  articles.clear();
  articles.set(ID, { status: "draft", sources: 1 });
});

describe("admin news review", () => {
  it("lists the review queue (drafts by default) for admins only", async () => {
    const ok = await GET(new Request("http://x/api/admin/news"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).articles[0].status).toBe("draft");
    isAdmin = false;
    expect((await GET(new Request("http://x/api/admin/news"))).status).toBe(403);
  });

  it("publishes a reviewed draft and writes the audit log", async () => {
    const res = await patch(ID, { status: "published" });
    expect(res.status).toBe(200);
    expect(articles.get(ID)?.status).toBe("published");
    expect(audit).toHaveLength(1);
  });

  it("refuses to publish an article without an original source", async () => {
    articles.set(ID, { status: "draft", sources: 0 });
    const res = await patch(ID, { status: "published" });
    expect(res.status).toBe(422);
    expect(articles.get(ID)?.status).toBe("draft");
  });

  it("validates id and status", async () => {
    expect((await patch("not-a-uuid", { status: "published" })).status).toBe(400);
    expect((await patch(ID, { status: "deleted" })).status).toBe(400);
    expect((await patch("22222222-2222-4222-8222-222222222222", { status: "archived" })).status).toBe(404);
  });
});
