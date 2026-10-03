import { describe, it, expect } from "vitest";
import { AudioFeedQuerySchema, AudioSearchQuerySchema } from "@/lib/audio/query-schemas";

const feedTestables = { QuerySchema: AudioFeedQuerySchema };
const searchTestables = { QuerySchema: AudioSearchQuerySchema };

describe("api/audio/feed query validation", () => {
    const { QuerySchema } = feedTestables;

    it("default la tab=all cand parametrul lipseste", () => {
        const parsed = QuerySchema.safeParse({});
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.tab).toBe("all");
    });

    it("accepta doar tab-urile cunoscute", () => {
        for (const tab of ["all", "radio", "audius", "jamendo", "podcast"]) {
            expect(QuerySchema.safeParse({ tab }).success).toBe(true);
        }
    });

    it("respinge un tab necunoscut", () => {
        expect(QuerySchema.safeParse({ tab: "spotify" }).success).toBe(false);
        expect(QuerySchema.safeParse({ tab: "<script>" }).success).toBe(false);
    });
});

describe("api/audio/search query validation", () => {
    const { QuerySchema } = searchTestables;

    it("trimeaza spatiile din q si respinge peste 100 caractere", () => {
        const parsed = QuerySchema.safeParse({ q: "  kiss fm  " });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.q).toBe("kiss fm");

        expect(QuerySchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
        expect(QuerySchema.safeParse({ q: "a".repeat(100) }).success).toBe(true);
    });

    it("permite q lipsa (raspuns gol, nu 400) si default source=all", () => {
        const parsed = QuerySchema.safeParse({});
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.q).toBe("");
            expect(parsed.data.source).toBe("all");
        }
    });

    it("accepta doar sursele cunoscute", () => {
        for (const source of ["all", "radio", "audius", "jamendo", "podcast"]) {
            expect(QuerySchema.safeParse({ q: "test", source }).success).toBe(true);
        }
        expect(QuerySchema.safeParse({ q: "test", source: "spotify" }).success).toBe(false);
    });
});
