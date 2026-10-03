import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFeedUrl, fetchFeedPage, parseFeedPage } from "@/lib/feed/client/feed-source";

describe("buildFeedUrl", () => {
  it("prima pagină For You: fără cursor, cu clip fixat, categorie, limbă", () => {
    const url = buildFeedUrl({ sessionId: "s 1", category: "beauty", pinnedVideoId: "v1", locale: "en" });
    const sp = new URL(url, "https://x.test").searchParams;
    expect(url.startsWith("/api/explore/feed?")).toBe(true);
    expect(sp.get("limit")).toBe("12");
    expect(sp.has("cursor")).toBe(false);
    expect(sp.has("page")).toBe(false);
    expect(sp.get("session_id")).toBe("s 1");
    expect(sp.get("category")).toBe("beauty");
    expect(sp.get("locale")).toBe("en");
    expect(sp.get("v")).toBe("v1");
    expect(sp.has("source")).toBe(false);
  });

  it("paginile următoare trimit cursorul și nu mai trimit clipul fixat; Following trimite source", () => {
    const sp = new URL(buildFeedUrl({ cursor: "abc", source: "following", pinnedVideoId: "v1", creatorId: "c1" }), "https://x.test")
      .searchParams;
    expect(sp.get("cursor")).toBe("abc");
    expect(sp.get("source")).toBe("following");
    expect(sp.has("v")).toBe(false);
    expect(sp.get("creator_id")).toBe("c1");
  });
});

describe("parseFeedPage", () => {
  it("tolerează răspunsuri incomplete și filtrează itemii invalizi", () => {
    expect(parseFeedPage(null)).toEqual({ items: [], nextCursor: null, hasMore: false, requestId: null, ab: null });
    const page = parseFeedPage({
      items: [{ kind: "video", key: "video:a", video: { id: "a" } }, { kind: "news", key: "x" }, 5],
      nextCursor: "c",
      hasMore: true,
      requestId: "r",
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.requestId).toBe("r");
  });

  it("hasMore fără cursor = false (nu putem continua)", () => {
    expect(parseFeedPage({ items: [], hasMore: true, nextCursor: null }).hasMore).toBe(false);
  });
});

describe("fetchFeedPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returnează null la eroare HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await fetchFeedPage({})).toBeNull();
  });

  it("parsează pagina și trimite cursorul", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ items: [{ kind: "video", key: "video:v", video: { id: "v" } }], nextCursor: null, hasMore: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchFeedPage({ cursor: "k2" });
    expect(page?.items).toHaveLength(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("cursor=k2");
  });
});
