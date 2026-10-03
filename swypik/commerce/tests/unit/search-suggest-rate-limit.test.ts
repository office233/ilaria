import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  allowed: true,
  searchProducts: vi.fn(),
  searchCreators: vi.fn(),
  searchHashtags: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => ({ success: h.allowed, remaining: h.allowed ? 1 : 0 }),
  getClientIP: () => "203.0.113.10",
}));
vi.mock("@/lib/search/query", () => ({
  searchProducts: h.searchProducts,
  searchCreators: h.searchCreators,
  searchHashtags: h.searchHashtags,
}));
vi.mock("@/lib/moderation/moderateText", () => ({
  moderateText: () => ({ action: "allow", message: null }),
}));
vi.mock("@/lib/http/cache-policy", () => ({
  applyCachePolicy: (response: Response) => response,
}));

import { GET } from "@/app/api/search/suggest/route";

beforeEach(() => {
  h.allowed = true;
  h.searchProducts.mockReset().mockResolvedValue([]);
  h.searchCreators.mockReset().mockResolvedValue([]);
  h.searchHashtags.mockReset().mockResolvedValue([]);
});

describe("search suggestions rate limit", () => {
  it("returns 429 before search queries when the distributed limiter blocks", async () => {
    h.allowed = false;
    const res = await GET(new Request("https://swypik.com/api/search/suggest?q=phone"));
    expect(res.status).toBe(429);
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(h.searchCreators).not.toHaveBeenCalled();
    expect(h.searchHashtags).not.toHaveBeenCalled();
  });

  it("allows normal suggestion search", async () => {
    const res = await GET(new Request("https://swypik.com/api/search/suggest?q=phone"));
    expect(res.status).toBe(200);
    expect(h.searchProducts).toHaveBeenCalled();
  });
});
