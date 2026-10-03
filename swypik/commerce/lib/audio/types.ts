/**
 * Tipuri de date unificate pentru Swypik Audio.
 * Acoperă: Radio Live, Audius (Muzică urbană/electro), Jamendo (Chill/Indie) și Podcasturi.
 */

export type AudioSourceType = "radio" | "audius" | "jamendo" | "podcast" | "swypik";

export interface AudioItemDto {
    id: string;
    slug: string;
    title: string;
    artist: string;
    coverUrl: string | null;
    streamUrl: string;
    /** URL-uri alternative (https) încercate în ordine dacă `streamUrl` nu pornește (ex. `url` brut Radio-Browser). */
    streamUrlFallbacks?: string[];
    durationMs: number; // 0 pentru Radio Live
    genre: string;
    source: AudioSourceType;
    isLive?: boolean;
    bitrateKbps?: number;
    stationCountry?: string;
    stationVotes?: number;
    externalUrl?: string;
    /** Licența permite uz într-un context monetizat (feed cu reclame, reels) — vezi lib/audio/license.ts. */
    licensedForCommercial?: boolean;
    licenseUrl?: string | null;
}

/** Surse externe care au nevoie de o cheie; fără ea, API-ul le raportează ca neconfigurate (fără date false). */
export type AudioSourceStatus = { source: AudioSourceType; configured: boolean };

/** ID-uri stabile de secțiuni feed — clientul le traduce, serverul nu mai trimite text RO hardcodat. */
export type AudioFeedSectionId =
    | "section-radio-ro"
    | "section-radio-global"
    | "section-audius"
    | "section-jamendo"
    | "section-podcasts";

export interface AudioFeedSection {
    id: AudioFeedSectionId;
    source: AudioSourceType;
    items: AudioItemDto[];
}

export interface AudioFeedResponse {
    /** Doar secțiunile cu conținut — cele goale nu se trimit. */
    sections: AudioFeedSection[];
    /** Sursele care cer cheie de API și nu sunt configurate (ex. Jamendo fără JAMENDO_CLIENT_ID). */
    unconfigured: AudioSourceType[];
}

import type { TrackDto } from "@/lib/music/types";

export function audioItemToTrackDto(item: AudioItemDto): TrackDto {
    return {
        id: item.id,
        slug: item.slug,
        title: item.title,
        coverUrl: item.coverUrl,
        genre: item.genre,
        durationMs: item.durationMs,
        explicit: false,
        isPremium: false,
        priceCents: null,
        locked: false,
        allowReels: false,
        audioTrackId: null,
        albumId: null,
        trackNumber: null,
        artist: {
            id: `artist-${item.source}-${item.artist.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
            slug: item.artist.toLowerCase().replace(/[^a-z0-9]/g, "-"),
            stageName: item.artist,
            bio: "",
            avatarUrl: item.coverUrl,
            coverUrl: item.coverUrl,
            isOfficial: false,
        },
        // Sursele externe nu au statistici Swypik — nu inventăm redări.
        plays7d: 0,
        liked: false,
        source: item.source,
        streamUrl: item.streamUrl,
        streamUrlFallbacks: item.streamUrlFallbacks,
        isLive: item.isLive,
        licenseUrl: item.licenseUrl ?? null,
        externalUrl: item.externalUrl ?? null,
    };
}
