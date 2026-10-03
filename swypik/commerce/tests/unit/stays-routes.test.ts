import { beforeEach, describe, expect, it, vi } from "vitest";

const session = { current: null as null | { userId: string } };
const rl = { success: true };
vi.mock("@/lib/auth/session", () => ({ getAuthSession: vi.fn(async () => session.current) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => rl), getClientIP: () => "1.2.3.4" }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })), withTransaction: vi.fn() }));

const createBookingRequest = vi.fn();
vi.mock("@/lib/stays/booking", () => ({ createBookingRequest: (...a: unknown[]) => createBookingRequest(...a) }));
const acceptBooking = vi.fn();
vi.mock("@/lib/stays/host-decisions", () => ({ acceptBooking: (...a: unknown[]) => acceptBooking(...a), declineBooking: vi.fn() }));
const getActiveHost = vi.fn();
vi.mock("@/lib/stays/hosts", async () => {
    const { StaysError } = await import("@/lib/stays/errors");
    return {
        getActiveHost: (...a: unknown[]) => getActiveHost(...a),
        requireHost: async (id: string) => {
            const h = await getActiveHost(id);
            if (!h) throw new StaysError("not_host");
            return h;
        },
    };
});

import { POST as bookPOST } from "@/app/api/stays/bookings/route";
import { POST as acceptPOST } from "@/app/api/host/bookings/[id]/accept/route";
import { GET as mineGET } from "@/app/api/stays/mine/route";
import { POST as legacyAvailPOST } from "@/app/api/stays/availability/route";
import { StaysError } from "@/lib/stays/errors";

const ID = "22222222-2222-4222-8222-222222222222";
const body = {
    product_id: ID,
    check_in: "2030-01-10",
    check_out: "2030-01-12",
    guests_count: 2,
    guest_name: "Ana Pop",
    guest_email: "ana@example.com",
};
const post = (url: string, b: unknown) => new Request(url, { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
    vi.clearAllMocks();
    session.current = { userId: "guest-1" };
    rl.success = true;
});

describe("POST /api/stays/bookings", () => {
    it("requires a signed-in user (anonymous holds used to block calendars)", async () => {
        session.current = null;
        const res = await bookPOST(post("https://x/api/stays/bookings", body));
        expect(res.status).toBe(401);
        expect(createBookingRequest).not.toHaveBeenCalled();
    });

    it("is rate limited per user", async () => {
        rl.success = false;
        const res = await bookPOST(post("https://x/api/stays/bookings", body));
        expect(res.status).toBe(429);
    });

    it("requires email or phone", async () => {
        const { guest_email: _e, ...noContact } = body;
        const res = await bookPOST(post("https://x/api/stays/bookings", noContact));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_input" });
    });

    it("creates the pending booking for the session user", async () => {
        createBookingRequest.mockResolvedValue({ bookingId: "b-1", totalCents: 1, currency: "RON", expiresAt: "t" });
        const res = await bookPOST(post("https://x/api/stays/bookings", body));
        expect(res.status).toBe(200);
        expect(createBookingRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: "guest-1", productId: ID, guests: 2 }));
    });

    it("turns domain errors into stable codes + HTTP status", async () => {
        createBookingRequest.mockRejectedValue(new StaysError("dates_booked"));
        const res = await bookPOST(post("https://x/api/stays/bookings", body));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "dates_booked" });
    });
});

describe("POST /api/host/bookings/[id]/accept", () => {
    const ctx = { params: Promise.resolve({ id: ID }) };
    it("is limited to active hosts", async () => {
        getActiveHost.mockResolvedValue(null);
        const res = await acceptPOST(post(`https://x/api/host/bookings/${ID}/accept`, {}), ctx);
        expect(res.status).toBe(403);
        expect(acceptBooking).not.toHaveBeenCalled();
    });

    it("accepts as the session host", async () => {
        getActiveHost.mockResolvedValue({ userId: "guest-1" });
        acceptBooking.mockResolvedValue({ status: "confirmed" });
        const res = await acceptPOST(post(`https://x/api/host/bookings/${ID}/accept`, {}), { params: Promise.resolve({ id: ID }) });
        expect(res.status).toBe(200);
        expect(acceptBooking).toHaveBeenCalledWith(ID, "guest-1");
    });

    it("rejects malformed ids", async () => {
        getActiveHost.mockResolvedValue({ userId: "guest-1" });
        const res = await acceptPOST(post("https://x/api/host/bookings/x/accept", {}), { params: Promise.resolve({ id: "x" }) });
        expect(res.status).toBe(404);
    });
});

describe("legacy seller calendar (single host model)", () => {
    it("is retired with 410", async () => {
        expect((await mineGET()).status).toBe(410);
        expect((await legacyAvailPOST()).status).toBe(410);
    });
});
