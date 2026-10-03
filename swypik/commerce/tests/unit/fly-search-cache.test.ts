import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  duffelSearch: vi.fn(),
}));

vi.mock("@/lib/fly/duffel", () => ({
  duffelProvider: {
    id: "duffel",
    isConfigured: () => true,
    search: h.duffelSearch,
    priceCheck: vi.fn(),
    createOrder: vi.fn(),
  },
}));
vi.mock("@/lib/fly/kiwi", () => ({
  kiwiProvider: {
    id: "kiwi",
    isConfigured: () => false,
    search: vi.fn(),
    priceCheck: vi.fn(),
    createOrder: vi.fn(),
  },
}));
vi.mock("@/lib/fly/repricing", () => ({
  getRouteMarkupRonCents: async () => null,
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: vi.fn(),
    set: vi.fn(),
  }),
}));

import { searchFlightsCached } from "@/lib/fly/service";

const offer = {
  provider: "duffel" as const,
  offerId: "off-1",
  providerTotalCents: 10000,
  providerCurrency: "EUR",
  markupCents: 1000,
  totalCents: 11000,
  currency: "EUR",
  slices: [{
    origin: "OTP",
    destination: "BCN",
    segments: [{
      origin: "OTP",
      destination: "BCN",
      departAt: "2026-10-10T08:00:00Z",
      arriveAt: "2026-10-10T11:00:00Z",
      carrier: "W6",
      flightNumber: "123",
    }],
  }],
  stops: 0,
  carrier: "W6",
};

beforeEach(() => {
  delete process.env.REDIS_URL;
  h.duffelSearch.mockReset().mockResolvedValue([offer]);
});

describe("Fly short search cache", () => {
  it("coalesces identical searches so the provider is called once", async () => {
    const params = {
      origin: "OTP",
      destination: "BCN",
      departDate: "2026-10-10",
      returnDate: null,
      adults: 1,
      children: 0,
      infants: 0,
      cabin: "economy" as const,
      currency: "EUR",
      maxResults: 20,
    };
    const first = await searchFlightsCached(params);
    const second = await searchFlightsCached(params);
    expect(h.duffelSearch).toHaveBeenCalledTimes(1);
    expect(first.offers[0].token).toBe(second.offers[0].token);
  });
});
