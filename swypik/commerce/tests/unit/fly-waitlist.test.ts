import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { sql: string; params: unknown[] }[] = [];
const rl = { success: true };
vi.mock("@/lib/db", () => ({
    dbQuery: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
    }),
}));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: vi.fn(async () => rl), getClientIP: () => "1.2.3.4" }));
vi.mock("@/lib/auth/session", () => ({ getAuthSession: vi.fn(async () => null) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/fly/waitlist/route";
import { flyBookingGuard } from "@/lib/fly/gate";

const req = (b: unknown) => new Request("https://swypik.com/api/fly/waitlist", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
    calls.length = 0;
    rl.success = true;
});

describe("POST /api/fly/waitlist", () => {
    it("stores a normalized signup (upsert on lower(email))", async () => {
        const res = await POST(req({ email: " Ana@Example.COM ", destination: "Roma", origin: "otp", locale: "en" }));
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toContain("ON CONFLICT ((lower(email)))");
        expect(calls[0].params).toEqual(["ana@example.com", null, "OTP", "Roma", "en"]);
    });

    it("rejects invalid email with a stable code", async () => {
        const res = await POST(req({ email: "nope" }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_input" });
        expect(calls).toHaveLength(0);
    });

    it("silently drops honeypot submissions", async () => {
        const res = await POST(req({ email: "bot@example.com", website: "http://spam" }));
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(0);
    });

    it("is rate limited per IP", async () => {
        rl.success = false;
        const res = await POST(req({ email: "a@example.com" }));
        expect(res.status).toBe(429);
        expect(calls).toHaveLength(0);
    });
});

describe("Fly booking gate", () => {
    it("closes search/booking routes while FEATURE_FLY_BOOKING is off (default)", async () => {
        const res = flyBookingGuard();
        expect(res?.status).toBe(404);
        expect(await res?.json()).toEqual({ error: "fly_not_available" });
    });
});
