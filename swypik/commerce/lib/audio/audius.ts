/**
 * Client Audius REST API pentru Swypik Audio (Tab 2: Muzică & Beat-uri).
 * Accesează piese trending, căutare și stream direct MP3 fără restricții.
 * Suportă opțional AUDIUS_API_KEY / AUDIUS_BEARER_TOKEN din env.
 */

import type { AudioItemDto } from "./types";

interface AudiusTrack {
    id: string;
    title: string;
    user: {
        id: string;
        name: string;
        handle: string;
    };
    artwork?: {
        "480x480"?: string;
        "150x150"?: string;
    };
    duration: number; // secunde
    genre?: string;
    play_count?: number;
    description?: string;
}

interface AudiusResponse {
    data: AudiusTrack[];
}

const FETCH_TIMEOUT_MS = 5_000;

let cachedTrending: { data: AudioItemDto[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 ore

function getHeaders(): HeadersInit {
    const token = process.env.AUDIUS_BEARER_TOKEN || process.env.AUDIUS_API_KEY;
    const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "SwypikAudio/1.0",
    };
    if (token) {
        headers["Authorization"] = `Bearer ${token.trim()}`;
    }
    return headers;
}

/**
 * Apel extern fără cache (preîncălzirea, lib/prewarm/catalogs.ts): `null` când
 * Audius nu răspunde, ca preîncălzirea să păstreze copia veche.
 */
export async function fetchAudiusTrending(limit = 25): Promise<AudioItemDto[] | null> {
    try {
        const url = `https://api.audius.co/v1/tracks/trending?app_name=swypik&limit=${limit}`;
        const res = await fetch(url, {
            headers: getHeaders(),
            cache: "no-store",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!res.ok) {
            return null;
        }

        const json = (await res.json()) as AudiusResponse;
        if (!json.data || !Array.isArray(json.data) || json.data.length === 0) {
            return null;
        }

        const tracks: AudioItemDto[] = json.data.map((t) => {
            const artwork = t.artwork?.["480x480"] || t.artwork?.["150x150"] || null;
            const slug = (t.title || "track").toLowerCase().replace(/[^a-z0-9]+/g, "-");

            return {
                id: `audius_${t.id}`,
                slug: `audius-${t.id}-${slug}`.slice(0, 80),
                title: t.title.trim(),
                artist: t.user?.name || "Audius Producer",
                coverUrl: artwork,
                streamUrl: `https://api.audius.co/v1/tracks/${t.id}/stream?app_name=swypik`,
                durationMs: (t.duration || 180) * 1000,
                genre: t.genre || "Urban & Beats",
                source: "audius",
                isLive: false,
                externalUrl: `https://audius.co/${t.user?.handle}/${slug}`,
            };
        });

        return tracks;
    } catch {
        return null;
    }
}

export async function getAudiusTrendingTracks(limit = 25): Promise<AudioItemDto[]> {
    if (cachedTrending && cachedTrending.expiresAt > Date.now()) {
        return cachedTrending.data;
    }
    const tracks = await fetchAudiusTrending(limit);
    if (!tracks) return [];
    cachedTrending = { data: tracks, expiresAt: Date.now() + CACHE_TTL_MS };
    return tracks;
}

export const getTrendingAudiusTracks = getAudiusTrendingTracks;


export async function searchAudiusTracks(query: string, limit = 20): Promise<AudioItemDto[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    try {
        const url = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(trimmed)}&app_name=swypik&limit=${limit}`;
        const res = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return [];

        const json = (await res.json()) as AudiusResponse;
        if (!json.data || !Array.isArray(json.data)) return [];

        return json.data.map((t) => {
            const artwork = t.artwork?.["480x480"] || t.artwork?.["150x150"] || null;
            const slug = (t.title || "track").toLowerCase().replace(/[^a-z0-9]+/g, "-");

            return {
                id: `audius_${t.id}`,
                slug: `audius-${t.id}-${slug}`.slice(0, 80),
                title: t.title.trim(),
                artist: t.user?.name || "Audius Producer",
                coverUrl: artwork,
                streamUrl: `https://api.audius.co/v1/tracks/${t.id}/stream?app_name=swypik`,
                durationMs: (t.duration || 180) * 1000,
                genre: t.genre || "Beats",
                source: "audius",
                isLive: false,
            };
        });
    } catch {
        return [];
    }
}
