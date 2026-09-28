/**
 * Helperi puri pentru Media Session API (lock screen, căști, ceas): metadatele
 * piesei curente și lista de acțiuni suportate (seek doar pentru conținut non-live).
 */
import type { TrackDto } from "@/lib/music/types";
import { MEDIA_SESSION_ARTWORK_SIZE } from "./config";

export type MediaSessionLabels = {
    /** Albumul afișat pentru radio live (tradus). */
    liveAlbum: string;
    /** Albumul implicit când piesa nu are gen (tradus / brand). */
    defaultAlbum: string;
};

export type MediaMetadataFields = {
    title: string;
    artist: string;
    album: string;
    artwork: { src: string; sizes: string; type?: string }[];
};

const ARTWORK_TYPES: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
};

/** Tipul MIME al copertei după extensie; necunoscut → omis (browserul îl deduce). */
export function artworkMimeType(url: string): string | undefined {
    try {
        const ext = new URL(url, "https://placeholder.invalid").pathname.split(".").pop()?.toLowerCase() ?? "";
        return ARTWORK_TYPES[ext];
    } catch {
        return undefined;
    }
}

type MetadataTrack = Pick<TrackDto, "title" | "coverUrl" | "genre" | "isLive"> & { artist: Pick<TrackDto["artist"], "stageName"> };

export function buildMediaMetadata(track: MetadataTrack, labels: MediaSessionLabels): MediaMetadataFields {
    const artwork: MediaMetadataFields["artwork"] = [];
    if (track.coverUrl) {
        const type = artworkMimeType(track.coverUrl);
        artwork.push(type ? { src: track.coverUrl, sizes: MEDIA_SESSION_ARTWORK_SIZE, type } : { src: track.coverUrl, sizes: MEDIA_SESSION_ARTWORK_SIZE });
    }
    return {
        title: track.title,
        artist: track.artist.stageName,
        album: track.isLive ? labels.liveAlbum : track.genre || labels.defaultAlbum,
        artwork,
    };
}

export type PlayerMediaAction = "play" | "pause" | "stop" | "nexttrack" | "previoustrack" | "seekto" | "seekbackward" | "seekforward";

const BASE_ACTIONS: readonly PlayerMediaAction[] = ["play", "pause", "stop", "nexttrack", "previoustrack"];
const SEEK_ACTIONS: readonly PlayerMediaAction[] = ["seekto", "seekbackward", "seekforward"];

/** Acțiunile înregistrate; fluxurile live nu au seek. */
export function mediaSessionActions(isLive: boolean | undefined): PlayerMediaAction[] {
    return isLive ? [...BASE_ACTIONS] : [...BASE_ACTIONS, ...SEEK_ACTIONS];
}

/** Toate acțiunile pe care le putem înregistra — folosit la curățare. */
export const ALL_MEDIA_ACTIONS: readonly PlayerMediaAction[] = [...BASE_ACTIONS, ...SEEK_ACTIONS];
