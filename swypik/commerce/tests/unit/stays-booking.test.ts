import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (sql: string, params: unknown[]) => { rows: unknown[] } | Error;
let handler: Handler = () => ({ rows: [] });
const calls: { sql: string; params: unknown[] }[] = [];

async function run(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const r = handler(sql, params);
    if (r instanceof Error) throw r;
    return { rows: r.rows, rowCount: r.rows.length };
}

vi.mock("@/lib/db", () => ({
    dbQuery: (sql: string, params: unknown[]) => run(sql, params),
    withTransaction: async (fn: (q: typeof run) => Promise<unknown>) => fn(run),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createBookingRequest, quoteStay } from "@/lib/stays/booking";
import { StaysError } from "@/lib/stays/errors";

const LISTING = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Casa din deal",
    status: "active",
    currency: "RON",
    price_cents: 20000,
    vertical_attributes: null,
    max_guests: 4,
    host_user_id: "host-1",
};
const NOW = new Date("2026-10-01T08:00:00Z");
const input = {
    productId: LISTING.id,
    userId: "guest-1",
    guestName: "Ana Pop",
    guestEmail: "ana@example.com",
    guestPhone: null,
    checkIn: "2026-10-10",
    checkOut: "2026-10-13",
    guests: 2,
};

function world(opts: { blocked?: number; booked?: number; overrides?: { day: string; price_cents_override: number }[]; listing?: object | null; insertError?: Error }) {
    handler = (sql) => {
        if (sql.includes("FROM marketplace_products p")) return { rows: opts.listing === null ? [] : [{ ...LISTING, ...(opts.listing ?? {}) }] };
        if (sql.includes("FROM stay_availability") && sql.includes("is_available = false")) return { rows: [{ n: opts.blocked ?? 0 }] };
        if (sql.includes("FROM stay_bookings b")) return { rows: [{ n: opts.booked ?? 0 }] };
        if (sql.includes("price_cents_override IS NOT NULL")) return { rows: opts.overrides ?? [] };
        if (sql.startsWith("INSERT INTO stay_bookings") || sql.includes("INSERT INTO stay_bookings")) {
            return opts.insertError ?? { rows: [{ id: "b-1", expires_at: "2026-10-01T08:15:00Z" }] };
        }
        return { rows: [] };
    };
}

beforeEach(() => {
    calls.length = 0;
});

describe("createBookingRequest", () => {
    it("expires stale pending holds for the listing before checking availability", async () => {
        world({});
        const b = await createBookingRequest(input, NOW);
        expect(b).toMatchObject({ bookingId: "b-1", totalCents: 60000, currency: "RON" });
        const expireIdx = calls.findIndex((c) => c.sql.includes("SET status = 'expired'"));
        const overlapIdx = calls.findIndex((c) => c.sql.includes("FROM stay_bookings b"));
        expect(expireIdx).toBeGreaterThan(-1);
        expect(expireIdx).toBeLessThan(overlapIdx);
        const insert = calls.find((c) => c.sql.includes("INSERT INTO stay_bookings"))!;
        expect(insert.sql).toContain("'pending', 'pending'");
        expect(insert.params).toContain("host-1");
        expect(insert.params.at(-1)).toBe(15); // STAYS_PENDING_TTL_MIN implicit
    });

    it("applies per-night price overrides to the total", async () => {
        world({ overrides: [{ day: "2026-10-11", price_cents_override: 30000 }] });
        const b = await createBookingRequest(input, NOW);
        expect(b.totalCents).toBe(70000);
    });

    it("rejects nights blocked by the host", async () => {
        world({ blocked: 1 });
        await expect(createBookingRequest(input, NOW)).rejects.toMatchObject({ code: "dates_blocked" });
    });

    it("rejects overlapping active bookings", async () => {
        world({ booked: 1 });
        await expect(createBookingRequest(input, NOW)).rejects.toMatchObject({ code: "dates_booked" });
    });

    it("maps the exclusion-constraint race (23P01) to dates_booked", async () => {
        world({ insertError: Object.assign(new Error("conflicting key"), { code: "23P01" }) });
        await expect(createBookingRequest(input, NOW)).rejects.toMatchObject({ code: "dates_booked" });
    });

    it("refuses booking your own listing, unpublished listings and too many guests", async () => {
        world({});
        await expect(createBookingRequest({ ...input, userId: "host-1" }, NOW)).rejects.toMatchObject({ code: "own_listing" });
        world({ listing: { status: "draft" } });
        await expect(createBookingRequest(input, NOW)).rejects.toMatchObject({ code: "not_published" });
        world({});
        await expect(createBookingRequest({ ...input, guests: 9 }, NOW)).rejects.toMatchObject({ code: "too_many_guests" });
    });

    it("validates the date range before touching the database", async () => {
        world({});
        await expect(createBookingRequest({ ...input, checkIn: "2026-09-01", checkOut: "2026-09-03" }, NOW)).rejects.toBeInstanceOf(StaysError);
        expect(calls).toHaveLength(0);
    });
});

describe("quoteStay", () => {
    it("returns a total when available and a stable reason code otherwise", async () => {
        world({});
        const ok = await quoteStay(LISTING.id, "2026-10-10", "2026-10-12", 2, NOW);
        expect(ok).toMatchObject({ available: true, nights: 2, totalCents: 40000, reason: null });
        world({ booked: 1 });
        const busy = await quoteStay(LISTING.id, "2026-10-10", "2026-10-12", 2, NOW);
        expect(busy).toMatchObject({ available: false, reason: "dates_booked" });
    });

    it("throws not_found for unknown listings", async () => {
        world({ listing: null });
        await expect(quoteStay(LISTING.id, "2026-10-10", "2026-10-12", 2, NOW)).rejects.toMatchObject({ code: "not_found" });
    });
});
