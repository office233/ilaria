import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response("frozen", { status: 410 }) }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => ({ userId: "u1", isAdmin: false }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 5 }), getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/movies/repository", () => ({
    upsertProgress: async () => {
        throw Object.assign(new Error("fk"), { code: "23503" });
    },
}));

import { constraintError } from "@/lib/movies/pg-errors";
import { POST } from "@/app/api/movies/progress/route";

describe("Postgres integrity errors → 4xx (P2)", () => {
    it("maps FK → 404 and UNIQUE → 409, anything else → null", () => {
        expect(constraintError({ code: "23503" })).toEqual({ status: 404, error: "not_found" });
        expect(constraintError({ code: "23505" })).toEqual({ status: 409, error: "conflict" });
        expect(constraintError(new Error("x"))).toBeNull();
        expect(constraintError(null)).toBeNull();
    });

    it("progress for a deleted episode → 404, not 500", async () => {
        const res = await POST(new Request("https://swypik.test/api/movies/progress", {
            method: "POST",
            body: JSON.stringify({ episodeId: "11111111-2222-4333-8444-555555555555", positionMs: 1000 }),
        }));
        expect(res.status).toBe(404);
    });
});
