import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: () => new Response(JSON.stringify({ ok: false }), { status: 410 }),
}));

let userId: string | null = "user-1";
vi.mock("@/lib/auth/getAuthUser", () => ({
  getAuthUser: async () => ({
    role: userId ? "shopper" : "guest",
    userId,
    sellerId: null,
    isAdmin: false,
    email: null,
  }),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
}));

const inserted: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT id FROM news_articles WHERE slug")) {
      return { rows: [{ id: "article-1" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO news_reactions")) {
      inserted.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM news_reactions")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { POST, DELETE } from "@/app/api/news/[slug]/reactions/route";

function req(method: string, body?: unknown, url = "http://localhost/api/news/some-slug/reactions"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const params = Promise.resolve({ slug: "some-slug" });

beforeEach(() => {
  userId = "user-1";
  inserted.length = 0;
});

describe("POST /api/news/[slug]/reactions", () => {
  it("rejects an unauthenticated request", async () => {
    userId = null;
    const res = await POST(req("POST", { reaction_type: "fire" }) as any, { params });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid reaction_type", async () => {
    const res = await POST(req("POST", { reaction_type: "not-a-real-type" }) as any, { params });
    expect(res.status).toBe(400);
  });

  it("rejects a missing body", async () => {
    const res = await POST(req("POST") as any, { params });
    expect(res.status).toBe(400);
  });

  it("accepts a valid reaction and persists it", async () => {
    const res = await POST(req("POST", { reaction_type: "fire" }) as any, { params });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(["article-1", "user-1", "fire"]);
  });
});

describe("DELETE /api/news/[slug]/reactions", () => {
  it("rejects an unauthenticated request", async () => {
    userId = null;
    const res = await DELETE(req("DELETE", undefined, "http://localhost/api/news/some-slug/reactions?reaction_type=fire") as any, { params });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid reaction_type query param", async () => {
    const res = await DELETE(req("DELETE", undefined, "http://localhost/api/news/some-slug/reactions?reaction_type=bogus") as any, { params });
    expect(res.status).toBe(400);
  });

  it("removes a valid reaction", async () => {
    const res = await DELETE(req("DELETE", undefined, "http://localhost/api/news/some-slug/reactions?reaction_type=fire") as any, { params });
    expect(res.status).toBe(200);
  });
});
