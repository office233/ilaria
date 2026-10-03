import { beforeEach, describe, expect, it, vi } from "vitest";

// Editarea unui titlu/piese publicate trebuie re-moderată (audit 2, P1).
let series: Record<string, unknown>;
const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response("frozen", { status: 410 }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 5 }), getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/creator/session", () => ({ getCreatorUserId: async () => "owner-1" }));
vi.mock("@/lib/movies/repository", () => ({
    getSeriesById: async () => series,
    listEpisodes: async () => [],
    updateSeries: async (_id: string, _owner: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        return { ...series, ...patch };
    },
}));

import { PATCH } from "@/app/api/creator/movies/[id]/route";
import { seriesEditNeedsReview } from "@/lib/movies/review";
import { trackEditNeedsReview } from "@/lib/music/review";
import type { MovieSeriesRow } from "@/lib/movies/types";
import type { MusicTrackRow } from "@/lib/music/types";

const patch = (body: unknown) =>
    PATCH(new Request("https://swypik.test/api/creator/movies/s1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "s1" }) });

beforeEach(() => {
    updates.length = 0;
    series = {
        id: "s1", owner_user_id: "owner-1", status: "published", title: "Titlu", synopsis: "", genres: ["drama"],
        cover_url: null, poster_url: "https://cdn.test/p.jpg", is_adult: false, license_note: "own work", free_episodes: 3, episode_price_cents: 500,
    };
});

describe("movies: re-review on creator edits of a published series", () => {
    it("poster / 18+ / fewer free episodes → back to pending_review", async () => {
        for (const body of [{ posterUrl: "https://cdn.test/other.jpg" }, { isAdult: true }, { freeEpisodes: 1 }]) {
            updates.length = 0;
            const res = await patch(body);
            expect(await res.json()).toMatchObject({ reReview: true });
            expect(updates[0]).toMatchObject({ status: "pending_review" });
        }
    });

    it("price-only edits and unchanged values keep the series published", async () => {
        const res = await patch({ episodePriceCents: 700, title: "Titlu" });
        expect(await res.json()).toMatchObject({ reReview: false });
        expect(updates[0]).not.toHaveProperty("status");
    });

    it("rejects http (non-https) poster URLs", async () => {
        expect((await patch({ posterUrl: "http://cdn.test/p.jpg" })).status).toBe(400);
    });

    it("drafts are edited freely", () => {
        expect(seriesEditNeedsReview({ ...series, status: "draft" } as unknown as MovieSeriesRow, { title: "Nou" })).toBe(false);
    });
});

describe("music: re-moderation on edits of a published track", () => {
    const track = { status: "published", title: "Piesa", cover_url: null, license_note: "mine", genre: "pop", explicit: false, audience: "general" } as unknown as MusicTrackRow;
    it("title / cover / explicit / audience changes need review; premium/price/reels do not", () => {
        expect(trackEditNeedsReview(track, { title: "Alta" })).toBe(true);
        expect(trackEditNeedsReview(track, { coverUrl: "https://cdn.test/c.jpg" })).toBe(true);
        expect(trackEditNeedsReview(track, { explicit: true })).toBe(true);
        expect(trackEditNeedsReview(track, { audience: "kids" })).toBe(true);
        expect(trackEditNeedsReview(track, { title: "Piesa" })).toBe(false);
        expect(trackEditNeedsReview(track, {})).toBe(false);
        expect(trackEditNeedsReview({ ...track, status: "draft" }, { title: "Alta" })).toBe(false);
    });
});
