import { describe, expect, it, vi } from "vitest";

let track: Record<string, unknown> | null = null;
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true }));
vi.mock("@/lib/music/repository", () => ({ getTrackBySlug: async () => track }));
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ccLicenseName, trackAttribution } from "@/lib/audio/attribution";
import { mapJamendoTracks } from "@/lib/audio/jamendo";
import { audioItemToTrackDto } from "@/lib/audio/types";
import { mergeSearchResults } from "@/lib/music/search";
import { resolvePublishedTrack } from "@/lib/music/track-page";
import type { TrackDto } from "@/lib/music/types";

describe("CC BY attribution for Jamendo tracks", () => {
    it("names the CC license from its URL", () => {
        expect(ccLicenseName("http://creativecommons.org/licenses/by-sa/3.0/")).toBe("CC BY-SA 3.0");
        expect(ccLicenseName("https://creativecommons.org/licenses/by/4.0/")).toBe("CC BY 4.0");
        expect(ccLicenseName("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0 1.0");
        expect(ccLicenseName("https://example.com/x")).toBeNull();
    });

    it("carries licenseUrl + share URL from Jamendo through to the TrackDto", () => {
        const [item] = mapJamendoTracks(
            [{ id: "7", name: "Song", duration: 100, artist_name: "Ana", audio: "https://a.test/7.mp3", license_ccurl: "http://creativecommons.org/licenses/by/3.0/", shareurl: "https://www.jamendo.com/track/7" }],
            "chill",
            false,
        );
        const dto = audioItemToTrackDto(item);
        expect(dto).toMatchObject({ licenseUrl: "http://creativecommons.org/licenses/by/3.0/", externalUrl: "https://www.jamendo.com/track/7" });
        expect(trackAttribution(dto)).toEqual({
            licenseName: "CC BY 3.0",
            licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
            sourceName: "Jamendo",
            sourceUrl: "https://www.jamendo.com/track/7",
        });
    });

    it("own-catalog tracks get no external attribution line", () => {
        expect(trackAttribution({ source: "swypik", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" })).toBeNull();
    });
});

describe("music search includes the Swypik catalog", () => {
    it("own tracks first, external after, no duplicate ids", () => {
        const a = { id: "own-1" } as TrackDto;
        const b = { id: "jamendo_1" } as TrackDto;
        expect(mergeSearchResults([a], [b, a]).map((t) => t.id)).toEqual(["own-1", "jamendo_1"]);
    });
});

describe("/music/track/<slug> returns a real 404", () => {
    it("missing or unpublished tracks resolve to null", async () => {
        track = null;
        expect(await resolvePublishedTrack("missing")).toBeNull();
        track = { status: "pending_review", title: "Secret", cover_url: null, genre: "pop", duration_ms: 1000, artist: { slug: "a", stage_name: "A" } };
        expect(await resolvePublishedTrack("secret")).toBeNull();
        track = { ...track, status: "published" };
        expect(await resolvePublishedTrack("ok")).toMatchObject({ title: "Secret" });
    });

    it("the page calls notFound() for them and marks the metadata noindex (no hardcoded RO meta)", () => {
        const src = readFileSync(join(__dirname, "..", "..", "app", "[locale]", "music", "track", "[slug]", "page.tsx"), "utf8");
        expect(src).toMatch(/if \(!track\) notFound\(\);/);
        expect(src).toContain("robots: { index: false }");
        expect(src).not.toContain("ro_RO");
        expect(src).not.toContain("Piesă negăsită");
    });

    it("the search panel queries the Swypik catalog too", () => {
        const src = readFileSync(join(__dirname, "..", "..", "app", "[locale]", "music", "_components", "SearchPanel.tsx"), "utf8");
        expect(src).toContain("/api/music/tracks?q=");
    });
});
