/**
 * Client Radio Browser API pentru Swypik Audio (Tab 1: Radio Live).
 *
 * Două straturi:
 *  - `fetch*Stations` — apel extern (mirror-uri, timeout), folosit DOAR de
 *    preîncălzire (cron `prewarm-catalogs`, lib/prewarm/catalogs.ts); întorc
 *    `null` când toate mirror-urile cad, ca preîncălzirea să păstreze copia veche.
 *  - calea cererii citește copia caldă din Redis (`getWarmCatalog("radio:ro")`,
 *    lib/prewarm/catalogs.ts) și nu așteaptă niciodată API-ul extern.
 *
 * Radio-Browser dă `url` (cel declarat) și `url_resolved` (după redirect/playlist):
 * redăm `url_resolved`, iar `url` (dacă e diferit și https) intră în
 * `streamUrlFallbacks` — playerul trece la el dacă primul nu pornește.
 */

import type { AudioItemDto } from "./types";
import { isSecureStreamUrl } from "./license";
import { CURATED_ROMANIAN_STATIONS } from "./radio-curated";

export { CURATED_ROMANIAN_STATIONS };

const RADIO_SERVERS = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
];

/** Timeout per mirror — dacă un server Radio Browser e lent, trecem rapid la următorul. */
const FETCH_TIMEOUT_MS = 5_000;
const USER_AGENT = "SwypikAudio/1.0";

export interface RawRadioStation {
    stationuuid: string;
    name: string;
    url?: string;
    url_resolved: string;
    favicon?: string;
    tags?: string;
    country?: string;
    votes?: number;
    codec?: string;
    bitrate?: number;
    lastcheckok?: number;
}

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** URL-uri https distincte, fără cel principal. */
export function streamFallbacks(primary: string, candidates: Array<string | null | undefined>): string[] {
    const out: string[] = [];
    for (const c of candidates) {
        if (!isSecureStreamUrl(c)) continue;
        const url = c.trim();
        if (url !== primary && !out.includes(url)) out.push(url);
    }
    return out;
}

export function mapRadioStation(s: RawRadioStation, defaults: { artist: string; country: string; genre: string }): AudioItemDto {
    const fallbacks = streamFallbacks(s.url_resolved, [s.url]);
    return {
        id: `radio_${s.stationuuid}`,
        slug: slugify(s.name),
        title: s.name.trim(),
        artist: defaults.artist,
        coverUrl: isSecureStreamUrl(s.favicon) ? s.favicon : null,
        streamUrl: s.url_resolved,
        ...(fallbacks.length ? { streamUrlFallbacks: fallbacks } : {}),
        durationMs: 0,
        genre: s.tags?.split(",")?.[0]?.trim() || defaults.genre,
        source: "radio",
        isLive: true,
        bitrateKbps: s.bitrate || 128,
        stationCountry: s.country || defaults.country,
        stationVotes: s.votes || 0,
    };
}

function isPlayable(s: RawRadioStation, requireCheckOk: boolean): boolean {
    return (!requireCheckOk || s.lastcheckok === 1) && isSecureStreamUrl(s.url_resolved) && Boolean(s.name);
}

/** Primul mirror care răspunde cu o listă nevidă; `null` dacă toate cad. */
async function queryMirrors(path: string): Promise<RawRadioStation[] | null> {
    for (const server of RADIO_SERVERS) {
        try {
            const res = await fetch(`${server}${path}`, {
                headers: { "User-Agent": USER_AGENT },
                cache: "no-store",
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) continue;
            const stations = (await res.json()) as RawRadioStation[];
            if (Array.isArray(stations) && stations.length > 0) return stations;
        } catch {
            // următorul mirror
        }
    }
    return null;
}

/**
 * Radiourile curatoriate, îmbogățite cu datele Radio-Browser ale aceluiași post
 * (siglă, URL-uri alternative), urmate de restul posturilor active din API.
 */
export function mergeWithCurated(raw: RawRadioStation[]): AudioItemDto[] {
    const byName = new Map(raw.map((s) => [s.name.trim().toLowerCase(), s]));
    const curated = CURATED_ROMANIAN_STATIONS.map((c): AudioItemDto => {
        const match = byName.get(c.title.toLowerCase());
        if (!match) return c;
        const fallbacks = streamFallbacks(c.streamUrl, [match.url_resolved, match.url]);
        return {
            ...c,
            coverUrl: c.coverUrl || (isSecureStreamUrl(match.favicon) ? match.favicon : null),
            ...(fallbacks.length ? { streamUrlFallbacks: fallbacks } : {}),
        };
    });
    const curatedNames = new Set(CURATED_ROMANIAN_STATIONS.map((c) => c.title.toLowerCase()));
    const rest = raw
        .filter((s) => isPlayable(s, true) && !curatedNames.has(s.name.trim().toLowerCase()))
        .map((s) => mapRadioStation(s, { artist: "Radio Live România", country: "România", genre: "Radio" }));
    return [...curated, ...rest];
}

/** Apel extern (doar preîncălzire). */
export async function fetchRomanianStations(limit = 40): Promise<AudioItemDto[] | null> {
    const raw = await queryMirrors(`/json/stations/bycountry/romania?order=votes&reverse=true&limit=${limit}`);
    return raw ? mergeWithCurated(raw) : null;
}

/** Apel extern (doar preîncălzire). */
export async function fetchTopGlobalStations(limit = 24): Promise<AudioItemDto[] | null> {
    const raw = await queryMirrors(`/json/stations/topclick/${limit}`);
    if (!raw) return null;
    return raw
        .filter((s) => isPlayable(s, true))
        .map((s) => mapRadioStation(s, { artist: s.country || "Global Radio", country: "Global", genre: "Hits" }));
}

export async function searchRadioStations(query: string, limit = 10): Promise<AudioItemDto[]> {
    if (!query.trim()) return [];
    const raw = await queryMirrors(`/json/stations/byname/${encodeURIComponent(query.trim())}?limit=${limit}`);
    if (!raw) return [];
    return raw
        .filter((s) => isPlayable(s, false))
        .map((s) => mapRadioStation(s, { artist: s.country || "Radio Live", country: "Live", genre: "Radio" }));
}
