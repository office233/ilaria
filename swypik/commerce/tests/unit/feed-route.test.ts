import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let userId: string | null = null;
let rateOk = true;
const CATALOG = Array.from({ length: 25 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  creator_id: `10000000-0000-4000-8000-${String((i % 5) + 1).padStart(12, "0")}`,
  published_at: new Date(Date.UTC(2026, 8, 20, 12) - i * 3_600_000).toISOString(),
  duration_ms: 12000,
}));
const sqlLog: string[] = [];

vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: async () => userId,
  getSocialIdentity: async () => (userId ? { userId, isAnon: false } : null),
  getAnonSigningKey: () => "test-key",
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: rateOk, remaining: 1 }),
  getClientIP: () => "1.2.3.4",
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => {
    throw new Error("REDIS_URL is missing");
  },
}));
vi.mock("@/lib/movies/feed-items", () => ({ getMovieFeedItems: async () => [] }));
vi.mock("@/lib/music/feed-items", () => ({ getMusicFeedItems: async () => [] }));
vi.mock("@/lib/stays/feed-items", () => ({ getStaysFeedItems: async () => [] }));
vi.mock("@/lib/db", () => ({
  dbQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    sqlLog.push(sql);
    if (sql.includes("AS video_id") && sql.includes("FROM videos v")) {
      const ids = params[0] as string[];
      const rows = CATALOG.filter((c) => ids.includes(c.id)).map((c) => ({
        video_id: c.id, creator_id: c.creator_id, description: "d", title: null, playback_url: "https://cdn/v.m3u8",
        thumbnail_url: null, duration_ms: c.duration_ms, like_count: 0, save_count: 0, share_count: 0, comment_count: 0,
        creator_name: "C", creator_username: "c", creator_verified: false, creator_avatar: null, source_key: null, preview_url: null,
        mp_id: null, caption_langs: [], viewer_liked: false, viewer_saved: false, viewer_following: false,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SELECT v.id::text AS id, v.creator_id::text AS creator_id")) {
      const exclude = new Set((params[0] as string[]) ?? []);
      const rows = CATALOG.filter((c) => !exclude.has(c.id));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM marketplace_products p") && sql.includes("LIMIT $1")) {
      const rows = [{ id: "p1", title: "Cană", image_url: "/c.jpg", price_cents: 4999, currency: "RON" }];
      return { rows, rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

import { GET } from "@/app/api/explore/feed/route";
import type { FeedResponse } from "@/lib/feed/types";

function get(qs = "", cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/explore/feed${qs}`, { headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  userId = null;
  rateOk = true;
  sqlLog.length = 0;
});

describe("GET /api/explore/feed — contract", () => {
  it("prima pagină: itemi unificați (clipuri + card de produs pe slot), videos compat, cursor, requestId", async () => {
    const res = await GET(get("?limit=10"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as FeedResponse;
    expect(body.videos).toHaveLength(10);
    expect(body.items.filter((i) => i.kind === "video")).toHaveLength(10);
    const productIdx = body.items.findIndex((i) => i.kind === "product");
    expect(productIdx).toBe(4);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
    expect(body.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(sqlLog.some((s) => /OFFSET/i.test(s))).toBe(false);
  });

  it("vizitator nou primește sesiunea de feed semnată (feed_sid)", async () => {
    const res = await GET(get("?limit=5"));
    expect(res.headers.get("set-cookie") ?? "").toContain("feed_sid=");
  });

  it("pagina următoare prin cursor: fără duplicate, până la epuizare", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await GET(get(`?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      const body = (await res.json()) as FeedResponse;
      for (const v of body.videos) {
        expect(seen.has(v.id)).toBe(false);
        seen.add(v.id);
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(CATALOG.length);
    expect(cursor).toBeNull();
  });

  it("cursor invalid = prima pagină (nu eroare)", async () => {
    const res = await GET(get("?limit=3&cursor=garbage"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as FeedResponse).videos).toHaveLength(3);
  });

  it("Following fără cont → gol, fără carduri", async () => {
    const body = (await (await GET(get("?source=following"))).json()) as FeedResponse;
    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it("profil de creator: keyset cronologic, fără carduri de modul", async () => {
    userId = "20000000-0000-4000-8000-000000000001";
    const body = (await (await GET(get(`?creator_id=${CATALOG[0].creator_id}&limit=5`))).json()) as FeedResponse;
    expect(body.items.every((i) => i.kind === "video")).toBe(true);
    expect(sqlLog.some((s) => s.includes("v.creator_id = $1::uuid"))).toBe(true);
  });

  it("rate limit → 429", async () => {
    rateOk = false;
    expect((await GET(get())).status).toBe(429);
  });
});
