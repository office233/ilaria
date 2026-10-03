/**
 * Client Jamendo v3 pentru Swypik Audio.
 *
 * Activ DOAR cu `JAMENDO_CLIENT_ID` în env — fără cheie nu există catalog
 * (niciun ID public de rezervă, nicio listă inventată): API-ul și UI-ul
 * raportează sursa ca „neconfigurată". Streamurile gratuite Jamendo sunt doar
 * pentru uz personal; într-o platformă monetizată afișăm numai piesele cu
 * licență CC BY / CC BY-SA (fără NC/ND) — `licensedForCommercial` — dacă nu
 * există un contract Jamendo Licensing (`JAMENDO_COMMERCIAL_LICENSE=1`).
 */
import type { AudioItemDto } from "./types";
import { isCommercialLicense, isSecureStreamUrl } from "./license";

interface JamendoTrack {
    id: string;
    name: string;
    duration: number; // secunde
    artist_name: string;
    album_name?: string;
    image?: string;
    audio?: string;
    audiodownload?: string;
    license_ccurl?: string;
    shareurl?: string;
}

interface JamendoResponse {
    results: JamendoTrack[];
}

const JAMENDO_API = "https://api.jamendo.com/v3.0/tracks/";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 ore
const CHILL_TAGS = "chillout+lounge+ambient";

let cachedChill: { data: AudioItemDto[]; expiresAt: number } | null = null;

export function jamendoClientId(): string | null {
    return process.env.JAMENDO_CLIENT_ID?.trim() || null;
}

export function isJamendoConfigured(): boolean {
    return jamendoClientId() !== null;
}

/** Contract Jamendo Licensing semnat ⇒ tot catalogul e utilizabil comercial. */
function hasCommercialDeal(): boolean {
    return process.env.JAMENDO_COMMERCIAL_LICENSE === "1";
}

/** Normalizare pură: doar https, doar licențe utilizabile comercial (fără contract). */
export function mapJamendoTracks(results: JamendoTrack[], genre: string, commercialDeal = hasCommercialDeal()): AudioItemDto[] {
    return results
        .map((t) => ({ t, stream: t.audio || t.audiodownload || "" }))
        .filter(({ stream }) => isSecureStreamUrl(stream))
        .map(({ t, stream }) => ({ t, stream, commercial: commercialDeal || isCommercialLicense(t.license_ccurl) }))
        .filter(({ commercial }) => commercial)
        .map(({ t, stream, commercial }) => {
            const slug = (t.name || "track").toLowerCase().replace(/[^a-z0-9]+/g, "-");
            return {
                id: `jamendo_${t.id}`,
                slug: `jamendo-${t.id}-${slug}`.slice(0, 80),
                title: t.name.trim(),
                artist: t.artist_name,
                coverUrl: isSecureStreamUrl(t.image) ? t.image : null,
                streamUrl: stream,
                durationMs: Math.max(0, t.duration || 0) * 1000,
                genre,
                source: "jamendo" as const,
                isLive: false,
                licensedForCommercial: commercial,
                licenseUrl: t.license_ccurl ?? null,
                externalUrl: isSecureStreamUrl(t.shareurl) ? t.shareurl : undefined,
            };
        });
}

async function fetchJamendo(params: Record<string, string>, genre: string, revalidate?: number): Promise<AudioItemDto[]> {
    const clientId = jamendoClientId();
    if (!clientId) return [];
    const url = new URL(JAMENDO_API);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("format", "json");
    url.searchParams.set("audioformat", "mp32");
    url.searchParams.set("include", "licenses");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
        const res = await fetch(url.toString(), {
            headers: { "User-Agent": "SwypikAudio/1.0" },
            ...(revalidate ? { next: { revalidate } } : {}),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const json = (await res.json()) as JamendoResponse;
        return Array.isArray(json.results) ? mapJamendoTracks(json.results, genre) : [];
    } catch {
        return [];
    }
}

export async function getJamendoChillTracks(tags = CHILL_TAGS, limit = 25): Promise<AudioItemDto[]> {
    if (!isJamendoConfigured()) return [];
    if (cachedChill && cachedChill.expiresAt > Date.now()) return cachedChill.data;
    const tracks = await fetchJamendo({ limit: String(limit), tags, featured: "1" }, "Chill & Lounge", 7200);
    if (tracks.length > 0) cachedChill = { data: tracks, expiresAt: Date.now() + CACHE_TTL_MS };
    return tracks;
}

/** Apel extern fără cache (preîncălzirea); `null` = neconfigurat sau fără răspuns. */
export async function fetchJamendoChill(limit = 15): Promise<AudioItemDto[] | null> {
    if (!isJamendoConfigured()) return null;
    const tracks = await fetchJamendo({ limit: String(limit), tags: CHILL_TAGS, featured: "1" }, "Chill & Lounge");
    return tracks.length > 0 ? tracks : null;
}

export async function getChillJamendoTracks(limit = 15): Promise<AudioItemDto[]> {
    return getJamendoChillTracks(CHILL_TAGS, limit);
}

export async function searchJamendoTracks(query: string, limit = 10): Promise<AudioItemDto[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    return fetchJamendo({ limit: String(limit), namesearch: trimmed }, "Indie / Creative Commons");
}
