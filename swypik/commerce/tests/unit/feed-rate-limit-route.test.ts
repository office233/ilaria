import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ user: vi.fn(), limit: vi.fn(), serve: vi.fn() }));
vi.mock("@/lib/social/session", () => ({
  getOptionalSocialUserId: mocks.user,
  getAnonSigningKey: () => "feed-rate-limit-test-signing-key",
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: mocks.limit, getClientIP: () => "192.0.2.1" }));
vi.mock("@/lib/feed/serve", () => ({ serveFeed: mocks.serve }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { GET } from "@/app/api/explore/feed/route";
import { signFeedSession } from "@/lib/feed/feed-session";
const counts = new Map<string, number>();
function request(n = 0, cookie?: string) {
  return new NextRequest(`https://swypik.com/api/explore/feed?session_id=rotated-session-${n}`, {
    headers: cookie ? { cookie: `feed_sid=${cookie}` } : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  counts.clear();
  mocks.user.mockResolvedValue(null);
  mocks.serve.mockResolvedValue({ items: [], videos: [], hasMore: false, nextCursor: null });
  // Stateful limiter double: exercises the actual route budgets/keys, no Redis,
  // network requests or production traffic. Real cookie verification is used.
  mocks.limit.mockImplementation(async (prefix: string, id: string, cfg = { limit: 30, window: 60 }) => {
    const key = `${prefix}:${id}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { success: count <= cfg.limit, remaining: Math.max(0, cfg.limit - count) };
  });
});
describe("Feed abuse limits", () => {
  it("rotating query session ids cannot reset the no-cookie IP budget", async () => {
    for (let i = 0; i < 120; i++) expect((await GET(request(i))).status).toBe(200);
    const response = await GET(request(120));
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.serve).toHaveBeenCalledTimes(120);
    expect(counts.get("exploreFeed:ip:192.0.2.1")).toBe(121);
  });
  it("query rotation cannot evade the verified cookie budget", async () => {
    const cookie = signFeedSession("verified-session-one");
    for (let i = 0; i < 120; i++) expect((await GET(request(i, cookie))).status).toBe(200);
    expect((await GET(request(120, cookie))).status).toBe(429);
    expect(counts.get("exploreFeed:s:verified-session-one")).toBe(121);
    expect(counts.has("exploreFeed:ip:192.0.2.1")).toBe(false);
  });
  it("forged cookies do not create per-session budgets", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await GET(request(i, `forged-session-${i}.${"a".repeat(32)}`))).status).toBe(200);
    }
    expect(counts.get("exploreFeed:ip:192.0.2.1")).toBe(3);
  });
  it("a blocked IP does not reach authentication, cookie minting or feed queries", async () => {
    counts.set("exploreFeedIp:192.0.2.1", 1200);
    expect((await GET(request())).status).toBe(429);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.serve).not.toHaveBeenCalled();
    expect(mocks.limit).toHaveBeenCalledTimes(1);
  });
  it("authenticated accounts behind the same NAT keep separate budgets", async () => {
    mocks.user.mockResolvedValue("user-one");
    counts.set("exploreFeed:u:user-one", 120);
    expect((await GET(request(1))).status).toBe(429);
    mocks.user.mockResolvedValue("user-two");
    expect((await GET(request(2))).status).toBe(200);
    expect(counts.get("exploreFeedIp:192.0.2.1")).toBe(2);
    expect(counts.get("exploreFeed:u:user-two")).toBe(1);
  });
  it("verified anonymous viewers behind the same NAT keep separate budgets", async () => {
    counts.set("exploreFeed:s:verified-session-one", 120);
    expect((await GET(request(1, signFeedSession("verified-session-one")))).status).toBe(429);
    expect((await GET(request(2, signFeedSession("verified-session-two")))).status).toBe(200);
  });
  it("an authenticated viewer cannot rotate cookies/query to escape their budget", async () => {
    mocks.user.mockResolvedValue("user-one");
    counts.set("exploreFeed:u:user-one", 120);
    expect((await GET(request(1, signFeedSession("verified-session-one")))).status).toBe(429);
    expect((await GET(request(2, signFeedSession("verified-session-two")))).status).toBe(429);
    expect(mocks.serve).not.toHaveBeenCalled();
  });
});
