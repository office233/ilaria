import { beforeEach, describe, expect, it, vi } from "vitest";

// Shell-ul nativ (Capacitor) nu are voie să vândă deblocări digitale în afara IAP.
const createEpisodeUnlockIntent = vi.fn();
const createTrackUnlockIntent = vi.fn();
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true, frozenResponse: () => new Response("frozen", { status: 410 }) }));
vi.mock("@/lib/auth/getAuthUser", () => ({ getAuthUser: async () => ({ userId: "u1", isAdmin: false }) }));
vi.mock("@/lib/security/rate-limit", () => ({ rateLimit: async () => ({ success: true, remaining: 5 }), getClientIP: () => "127.0.0.1" }));
vi.mock("@/lib/movies/repository", () => ({ getSeriesBySlug: async () => ({ id: "s1" }) }));
vi.mock("@/lib/movies/unlock", () => ({ createEpisodeUnlockIntent: (a: unknown) => createEpisodeUnlockIntent(a), createSeasonUnlockIntent: vi.fn() }));
vi.mock("@/lib/movies/unlock-status", () => ({ getUnlockStatus: vi.fn() }));
vi.mock("@/lib/music/repository", () => ({ getTrackBySlug: async () => ({ id: "t1" }) }));
vi.mock("@/lib/music/unlock", () => ({ createTrackUnlockIntent: (a: unknown) => createTrackUnlockIntent(a) }));

import { isNativeAppHeaders, PURCHASE_UNAVAILABLE_IN_APP } from "@/lib/media/native-app";
import { POST as moviesUnlock } from "@/app/api/movies/[slug]/unlock/route";
import { POST as trackUnlock } from "@/app/api/music/tracks/[slug]/unlock/route";

const ctx = { params: Promise.resolve({ slug: "x" }) };
const body = JSON.stringify({ episodeId: "11111111-2222-4333-8444-555555555555" });

beforeEach(() => {
    vi.clearAllMocks();
    createEpisodeUnlockIntent.mockResolvedValue({ ok: true, alreadyUnlocked: false, clientSecret: "cs", amountCents: 500 });
    createTrackUnlockIntent.mockResolvedValue({ ok: true, alreadyUnlocked: false, clientSecret: "cs", amountCents: 300 });
});

describe("native app detection", () => {
    it("recognises the user-agent token, the header and the cookie", () => {
        expect(isNativeAppHeaders(new Headers({ "user-agent": "Mozilla/5.0 (iPhone) swypik-native/1.0 (ios)" }))).toBe(true);
        expect(isNativeAppHeaders(new Headers({ "x-swypik-native": "1" }))).toBe(true);
        expect(isNativeAppHeaders(new Headers({ cookie: "a=b; swypik_native=1" }))).toBe(true);
        expect(isNativeAppHeaders(new Headers({ "user-agent": "Mozilla/5.0 Chrome/130", cookie: "swypik_native=0" }))).toBe(false);
    });
});

describe("digital unlock purchases are hidden in native builds", () => {
    it("movies: 403 purchase_unavailable_in_app from the app, normal intent on the web", async () => {
        const app = await moviesUnlock(new Request("https://swypik.test/api/movies/x/unlock", { method: "POST", body, headers: { "user-agent": "swypik-native/1.0 (android)" } }), ctx);
        expect(app.status).toBe(403);
        expect(await app.json()).toEqual({ error: PURCHASE_UNAVAILABLE_IN_APP });
        expect(createEpisodeUnlockIntent).not.toHaveBeenCalled();

        const web = await moviesUnlock(new Request("https://swypik.test/api/movies/x/unlock", { method: "POST", body }), ctx);
        expect(web.status).toBe(200);
        expect(createEpisodeUnlockIntent).toHaveBeenCalledWith({ userId: "u1", episodeId: "11111111-2222-4333-8444-555555555555", seriesId: "s1" });
    });

    it("music: same rule for tracks", async () => {
        const app = await trackUnlock(new Request("https://swypik.test/api/music/tracks/x/unlock", { method: "POST", headers: { cookie: "swypik_native=1" } }), ctx);
        expect(app.status).toBe(403);
        expect(createTrackUnlockIntent).not.toHaveBeenCalled();
    });
});
