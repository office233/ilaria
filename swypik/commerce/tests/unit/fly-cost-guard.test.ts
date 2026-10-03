import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  searchFlightsCached: vi.fn(),
  priceCheck: vi.fn(),
  rateLimit: vi.fn(),
  identity: vi.fn(),
}));

vi.mock("@/lib/fly/gate", () => ({
  flyBookingGuard: () => null,
}));
vi.mock("@/lib/fly/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/fly/service")>();
  return {
    ...original,
    activeProviders: () => [{ id: "duffel" }],
    searchFlightsCached: h.searchFlightsCached,
    priceCheck: h.priceCheck,
  };
});
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: h.rateLimit,
  getClientIP: () => "203.0.113.10",
}));
vi.mock("@/lib/fly/request-identity", () => ({
  getFlyRequestIdentityKey: h.identity,
}));

import { POST as searchPost } from "@/app/api/fly/search/route";
import { POST as pricePost } from "@/app/api/fly/price-check/route";

beforeEach(() => {
  h.searchFlightsCached.mockReset().mockResolvedValue({
    offers: [],
    providers: ["duffel"],
    errors: [],
  });
  h.priceCheck.mockReset();
  h.rateLimit.mockReset().mockResolvedValue({ success: true, remaining: 10 });
  h.identity.mockReset().mockResolvedValue("anon:test");
});

describe("Fly provider-cost rate limits", () => {
  it("blocks search on the per-identity limiter before calling providers", async () => {
    h.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 19 })
      .mockResolvedValueOnce({ success: false, remaining: 0 });
    const res = await searchPost(new Request("https://swypik.com/api/fly/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "OTP",
        destination: "BCN",
        departDate: "2026-10-10",
        adults: 1,
        children: 0,
        infants: 0,
        cabin: "economy",
      }),
    }));
    expect(res.status).toBe(429);
    expect(h.searchFlightsCached).not.toHaveBeenCalled();
  });

  it("blocks live price-check on the per-identity limiter before provider access", async () => {
    h.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 29 })
      .mockResolvedValueOnce({ success: false, remaining: 0 });
    const res = await pricePost(new Request("https://swypik.com/api/fly/price-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "11111111-1111-4111-8111-111111111111" }),
    }));
    expect(res.status).toBe(429);
    expect(h.priceCheck).not.toHaveBeenCalled();
  });
});
