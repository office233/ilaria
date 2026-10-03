/**
 * Upload direct pe R2 pentru piese audio (Swypik Music). Chei separate de
 * spațiul video, sub `music/raw/<artist>/<track>/`, cu aceleași reguli de
 * sanitizare a numelor de fișier ca `buildRawVideoObjectKey` — plus o regulă
 * suplimentară: doar extensiile audio permise supraviețuiesc, restul devin
 * `.m4a` (worker-ul de normalizare din faza 2 va rescrie oricum fișierul).
 */
import { randomBytes } from "node:crypto";
import { MUSIC_ALLOWED_MIME } from "@/lib/music/config";
import { createPresignedPutUrl, sanitizePathPart } from "@/lib/storage/video-storage";

export const MUSIC_RAW_PREFIX = "music/raw";

const MUSIC_AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac"]);
const MUSIC_FALLBACK_EXTENSION = "m4a";

/**
 * Numele fișierului din bucket NU derivă din numele urcat de artist: un basename
 * aleator (128 biți) e singurul secret al obiectului pe domeniul public R2, iar
 * proxy-ul cu token nu-l trimite niciodată clientului (segment constant
 * `MUSIC_STREAM_FILE`). Doar extensia audio permisă supraviețuiește.
 */
function randomMusicFilename(filename: string): string {
    const match = filename.trim().match(/\.([a-zA-Z0-9]+)$/);
    const ext = match && MUSIC_AUDIO_EXTENSIONS.has(match[1].toLowerCase()) ? match[1].toLowerCase() : MUSIC_FALLBACK_EXTENSION;
    return `${randomBytes(8).toString("hex")}.${ext}`;
}

/** Cheia obiectului pentru o piesă în upload: `music/raw/<artist>/<track>/<aleator>.<ext>`. */
export function buildMusicObjectKey(artistUserId: string, trackId: string, filename: string): string {
    const safeArtist = sanitizePathPart(artistUserId);
    const safeTrack = sanitizePathPart(trackId);
    const safeFilename = randomMusicFilename(filename);
    return `${MUSIC_RAW_PREFIX}/${safeArtist}/${safeTrack}/${safeFilename}`;
}

/**
 * Un artist poate înregistra doar chei sub propriul prefix (fără segmente
 * `..` de traversare); folosit ca gardă la `POST /api/creator/music/tracks`.
 */
export function isOwnedMusicKey(key: string, artistUserId: string): boolean {
    const prefix = `${MUSIC_RAW_PREFIX}/${sanitizePathPart(artistUserId)}/`;
    if (!key.startsWith(prefix)) return false;
    return !key.split("/").includes("..");
}

export class UnsupportedAudioTypeError extends Error {
    constructor(contentType: string) {
        super(`unsupported_type:${contentType}`);
        this.name = "UnsupportedAudioTypeError";
    }
}

export type CreateAudioUploadUrlInput = {
    artistUserId: string;
    trackId: string;
    filename: string;
    contentType: string;
};

/** URL presemnat PUT pentru upload direct pe R2, sub cheia proprie artistului. */
export async function createAudioUploadUrl(
    input: CreateAudioUploadUrlInput,
): Promise<{ url: string; key: string; expiresIn: number }> {
    if (!(MUSIC_ALLOWED_MIME as readonly string[]).includes(input.contentType)) {
        throw new UnsupportedAudioTypeError(input.contentType);
    }
    const key = buildMusicObjectKey(input.artistUserId, input.trackId, input.filename);
    return createPresignedPutUrl(key, input.contentType);
}
