import { describe, it, expect, vi, afterEach } from "vitest";
import { searchAudiusTracks } from "@/lib/audio/audius";
import { searchJamendoTracks } from "@/lib/audio/jamendo";
import { searchRadioStations } from "@/lib/audio/radio-browser";
import { fetchPodcastEpisodes } from "@/lib/audio/podcast";

/**
 * Confirmă că, atunci când un upstream extern (Audius/Jamendo/Radio
 * Browser/iTunes) eșuează, funcțiile NU mai inventează date fictive
 * (fostele *_FALLBACK_TRACKS) — returnează listă goală, iar UI-ul afișează
 * starea tradusă „sursă indisponibilă" + retry (MusicClient.tsx).
 */
describe("lib/audio — fără fallback-uri fictive la eșec upstream", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("searchAudiusTracks returneaza [] daca API-ul Audius raspunde cu eroare", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
        const result = await searchAudiusTracks("test");
        expect(result).toEqual([]);
    });

    it("searchAudiusTracks returneaza [] daca fetch arunca o exceptie", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
        const result = await searchAudiusTracks("test");
        expect(result).toEqual([]);
    });

    it("searchJamendoTracks returneaza [] daca API-ul Jamendo raspunde cu eroare", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
        const result = await searchJamendoTracks("test");
        expect(result).toEqual([]);
    });

    it("searchJamendoTracks returneaza [] daca fetch arunca o exceptie", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
        const result = await searchJamendoTracks("test");
        expect(result).toEqual([]);
    });

    it("searchRadioStations returneaza [] daca toate mirror-urile Radio Browser esueaza", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
        const result = await searchRadioStations("kiss fm");
        expect(result).toEqual([]);
    });

    it("fetchPodcastEpisodes returneaza [] daca iTunes API raspunde cu eroare", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
        const result = await fetchPodcastEpisodes("test");
        expect(result).toEqual([]);
    });

    it("fiecare cerere catre un upstream extern foloseste un AbortSignal (timeout)", async () => {
        const fetchSpy = vi.fn(async (_url: string, _opts?: RequestInit) => ({ ok: false, status: 500, json: async () => ({}) }));
        vi.stubGlobal("fetch", fetchSpy);

        await searchAudiusTracks("test");
        await searchJamendoTracks("test");
        await searchRadioStations("test");
        await fetchPodcastEpisodes("test");

        expect(fetchSpy).toHaveBeenCalled();
        for (const call of fetchSpy.mock.calls) {
            const opts = call[1] as RequestInit | undefined;
            expect(opts?.signal).toBeInstanceOf(AbortSignal);
        }
    });
});
