import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { sql: string; params: unknown[] }[] = [];
let rows: Record<string, unknown>[] = [];
vi.mock("@/lib/db", () => ({
    dbQuery: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
    },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ success: true })), getClientIP: () => "1.2.3.4" }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: vi.fn(async () => null) }));

import { GET as searchGET, POST as searchPOST } from "@/app/api/stays/search/route";
import { getStaysFeedItems, toFeedItem } from "@/lib/stays/feed-items";
import { normalizeText, searchStays } from "@/lib/stays/search";

const ROW = {
    id: "p-1",
    title: "Apartament central",
    image_url: "https://cdn.example.com/stays/u/1.jpg",
    location_city: "Cluj-Napoca",
    price_cents: 25000,
    vertical_attributes: null,
    currency: "RON",
    max_guests: 4,
    property_type: "apartament",
    rating: "4.8",
    reviews_count: 12,
};

beforeEach(() => {
    calls.length = 0;
    rows = [ROW];
    delete process.env.RATEHAWK_API_KEY;
    delete process.env.DUFFEL_API_KEY;
});

describe("stays search", () => {
    it("normalizes Romanian diacritics for fuzzy city matching", () => {
        expect(normalizeText("  București ")).toBe("bucuresti");
        expect(normalizeText("Brașov")).toBe("brasov");
    });

    it("passes user text only as a bound parameter and filters to hosted, published stays", async () => {
        await searchStays({ q: "Cluj'; DROP TABLE x;--", guests: 3, checkIn: "2026-10-10", checkOut: "2026-10-12" });
        const { sql, params } = calls[0];
        expect(sql).not.toContain("DROP TABLE");
        expect(params).toContain("cluj'; drop table x;--");
        expect(sql).toContain("p.metadata->>'vertical' = 'stays'");
        expect(sql).toContain("p.status = 'active'");
        expect(sql).toContain("stays_unclaimed");
        expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM stay_bookings b/);
        expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM stay_availability a/);
        expect(params).toContain(3);
    });

    it("skips the date filter when the range is invalid", async () => {
        await searchStays({ checkIn: "2026-10-12", checkOut: "2026-10-10" });
        expect(calls[0].sql).not.toContain("stay_bookings b");
    });

    it("maps rows to results with a numeric rating", async () => {
        const [r] = await searchStays({});
        expect(r).toMatchObject({ id: "p-1", city: "Cluj-Napoca", pricePerNightCents: 25000, rating: 4.8, reviewsCount: 12 });
    });

    it("GET /api/stays/search returns 200 with results even without any external provider key (no more 503)", async () => {
        const res = await searchGET(new Request("https://swypik.com/api/stays/search?q=cluj&guests=2"));
        expect(res.status).toBe(200);
        expect((await res.json()).results).toHaveLength(1);
    });

    it("POST /api/stays/search rejects malformed input with a stable code", async () => {
        const res = await searchPOST(new Request("https://swypik.com/api/stays/search", { method: "POST", body: JSON.stringify({ checkIn: "tomorrow" }) }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_input" });
    });
});

describe("stays feed items", () => {
    it("returns normalized cards linking to the stay page", async () => {
        const items = await getStaysFeedItems({ locale: "en", limit: 5 });
        expect(items).toEqual([
            expect.objectContaining({
                kind: "stay",
                id: "p-1",
                title: "Apartament central",
                image: ROW.image_url,
                href: "/stays/p-1",
                priceCents: 25000,
                priceUnit: "night",
                subtitle: "Cluj-Napoca",
            }),
        ]);
        expect(items[0].priceLabel).toMatch(/250/);
        expect(items[0].priceLabel).not.toMatch(/250\.00/);
    });

    it("drops stays without an image or a price", () => {
        const base = { id: "x", title: "t", city: null, currency: "RON", maxGuests: null, rating: null, reviewsCount: 0, propertyType: null };
        expect(toFeedItem({ ...base, image: null, pricePerNightCents: 100 }, "ro")).toBeNull();
        expect(toFeedItem({ ...base, image: "https://x/y.jpg", pricePerNightCents: 0 }, "ro")).toBeNull();
    });
});
