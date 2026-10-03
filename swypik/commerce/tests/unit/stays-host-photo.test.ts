import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(), withTransaction: vi.fn() }));
process.env.MEDIA_PUBLIC_BASE_URL = "https://media.example.test";

import { isHostPhotoUrl } from "@/lib/stays/listings";

describe("isHostPhotoUrl (P2: host + path, not path only)", () => {
    it("accepts only our media host with the host's own stays/<uid>/ prefix", () => {
        expect(isHostPhotoUrl("https://media.example.test/stays/u1/a.jpg", "u1")).toBe(true);
        expect(isHostPhotoUrl("https://evil.test/stays/u1/a.jpg", "u1")).toBe(false);
        expect(isHostPhotoUrl("https://media.example.test/stays/u2/a.jpg", "u1")).toBe(false);
        expect(isHostPhotoUrl("https://media.example.test/x/stays/u1/a.jpg", "u1")).toBe(false);
        expect(isHostPhotoUrl("not a url", "u1")).toBe(false);
    });
});
