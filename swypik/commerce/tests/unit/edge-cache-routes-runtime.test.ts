/**
 * Rulează efectiv câteva rute publice/anonime și verifică antetele de cache:
 * public pe 200, fără Set-Cookie, `private, no-store` pe erori și pentru
 * vizitatorii cu sesiune (audiența `anonymous`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { NO_STORE, PUBLIC_ROUTES, cacheControlValue } from "@/lib/http/cache-policy";

const h = vi.hoisted(() => ({
  warm: vi.fn(async (name: string) => (name === "radio:ro" ? [{ id: "r1", title: "Kiss FM" }] : [])),
  newsFirstPage: vi.fn(async () => [{ id: "a1" }]),
  listArticles: vi.fn(async () => [{ id: "a2" }]),
  dbQuery: vi.fn(async () => ({ rows: [{ id: "g1" }] })),
  user: { userId: null as string | null, isAdmin: false },
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  frozenResponse: () => new Response("frozen", { status: 410 }),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: true, remaining: 10 }),
  getClientIP: () => "127.0.0.1",
}));
vi.mock("@/lib/prewarm/catalogs", () => ({ getWarmCatalog: h.warm }));
vi.mock("@/lib/audio/jamendo", () => ({ isJamendoConfigured: () => false }));
vi.mock("@/lib/prewarm/news", () => ({ getNewsFirstPage: h.newsFirstPage }));
vi.mock("@/lib/news/repository", () => ({
  listArticles: h.listArticles,
  getArticleBySlug: async (slug: string) => (slug === "ok" ? { id: "a1", slug } : null),
  clampPageSize: (n: number) => (Number.isFinite(n) ? n : 20),
}));
vi.mock("@/lib/db", () => ({ dbQuery: h.dbQuery }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => h.user }));
vi.mock("@/lib/music/viewer", () => ({ buildMusicViewer: async () => ({}) }));
vi.mock("@/lib/music/dto", () => ({ toTrackDto: (t: { id: string }) => ({ id: t.id, artist: { isOfficial: false } }) }));
vi.mock("@/lib/music/repository", () => ({
  listTracks: async () => [{ id: "t1" }],
  ensureLikedPlaylist: async () => "liked",
  listPlaylistTracks: async () => [],
  listPlaylists: async () => [],
  getLikedTrackIds: async () => new Set<string>(),
}));

import { GET as audioFeed } from "@/app/api/audio/feed/route";
import { GET as news } from "@/app/api/news/route";
import { GET as gamingGames } from "@/app/api/gaming/games/route";
import { GET as musicHome } from "@/app/api/music/home/route";

function get(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://swypik.test${path}`, { headers: cookie ? { cookie } : {} });
}

function expectPublic(res: Response, route: keyof typeof PUBLIC_ROUTES) {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe(cacheControlValue(PUBLIC_ROUTES[route].profile));
  expect(res.headers.get("set-cookie")).toBeNull();
}

beforeEach(() => {
  h.user = { userId: null, isAdmin: false };
  h.newsFirstPage.mockClear();
  h.listArticles.mockClear();
});

describe("audio/feed — doar copii calde, cache la edge", () => {
  it("200 public, secțiunea radio din copia caldă", async () => {
    const res = await audioFeed(get("/api/audio/feed?tab=radio"));
    expectPublic(res, "audio/feed");
    const body = await res.json();
    expect(body.sections[0].items[0].title).toBe("Kiss FM");
    expect(h.warm).toHaveBeenCalledWith("radio:ro");
  });

  it("query invalid → 400 no-store", async () => {
    const res = await audioFeed(get("/api/audio/feed?tab=spotify"));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control") ?? "").not.toContain("s-maxage");
  });
});

describe("news", () => {
  it("prima pagină implicită vine din copia caldă", async () => {
    const res = await news(get("/api/news"));
    expectPublic(res, "news");
    expect(h.newsFirstPage).toHaveBeenCalledWith(null);
    expect(h.listArticles).not.toHaveBeenCalled();
  });

  it("paginile următoare merg în Postgres", async () => {
    const res = await news(get("/api/news?offset=20"));
    expectPublic(res, "news");
    expect(h.listArticles).toHaveBeenCalled();
  });

  it("articol inexistent → 404 fără cache public", async () => {
    const res = await news(get("/api/news?slug=missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control") ?? "").not.toContain("public");
  });
});

describe("gaming/games", () => {
  it("200 public; eroare DB → 500 fără cache public", async () => {
    expectPublic(await gamingGames(get("/api/gaming/games")), "gaming/games");
    h.dbQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await gamingGames(get("/api/gaming/games"));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control") ?? "").not.toContain("public");
  });
});

describe("music/home — audiență anonimă", () => {
  it("vizitator anonim → public", async () => {
    expectPublic(await musicHome(get("/api/music/home")), "music/home");
  });

  it("cu sesiune → private, no-store", async () => {
    h.user = { userId: "u1", isAdmin: false };
    const res = await musicHome(get("/api/music/home", "swypik_session=tok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });
});
