/**
 * Căi de media pentru episoadele blocate.
 *
 * Clientul nu vede niciodată URL-ul real (public) al episodului: primește doar
 * `/api/movies/stream/<token>/<cale relativă>`. Proxy-ul rezolvă calea relativă
 * față de directorul episodului (derivat din `videos.playback_url`, citit din DB
 * pe baza token-ului) și refuză orice iese din acel director. Funcții pure.
 */
export const STREAM_ROUTE_PREFIX = "/api/movies/stream";
export const MUSIC_STREAM_ROUTE_PREFIX = "/api/music/stream";
/** Segmentul de cale cerut de client pentru o piesă premium — constant, ca basename-ul real să nu plece niciodată la client. */
export const MUSIC_STREAM_FILE = "audio";

/** Directorul episodului: `playback_url` până la ultimul `/` inclusiv. */
export function episodeMediaDir(playbackUrl: string): string {
    return playbackUrl.slice(0, playbackUrl.lastIndexOf("/") + 1);
}

/** Numele fișierului din `playback_url` (ex. `master.m3u8`). */
export function mediaBasename(playbackUrl: string): string {
    return playbackUrl.slice(playbackUrl.lastIndexOf("/") + 1);
}

/**
 * Rezolvă o cale relativă în interiorul directorului episodului. Întoarce
 * `null` pentru orice traversare (`..`, `%2e%2e`), cale absolută sau alt host —
 * comparația se face pe URL-ul normalizat, nu pe stringul brut.
 */
export function resolveEpisodeMediaUrl(playbackUrl: string, relativePath: string): string | null {
    if (!relativePath || relativePath.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) return null;
    const dir = episodeMediaDir(playbackUrl);
    let resolved: URL;
    try {
        resolved = new URL(relativePath, dir);
    } catch {
        return null;
    }
    const href = resolved.href;
    // Segmentele `%2e%2e` nu sunt normalizate de URL(); decodate ar ieși din director.
    if (/%2e/i.test(relativePath)) return null;
    return href.startsWith(dir) && href.length > dir.length ? href : null;
}

/**
 * Pentru rescrierea playlist-urilor: un URL absolut din interiorul directorului
 * episodului devine cale de proxy relativă; orice altceva rămâne neatins.
 */
export function toProxyPath(token: string, absoluteUrl: string, playbackUrl: string, prefix: string = STREAM_ROUTE_PREFIX): string {
    const dir = episodeMediaDir(playbackUrl);
    if (!absoluteUrl.startsWith(dir)) return absoluteUrl;
    return `${prefix}/${token}/${absoluteUrl.slice(dir.length)}`;
}

/**
 * Ținta upstream pentru proxy-ul Music: segmentul constant întoarce chiar
 * obiectul piesei (URL-ul derivat din `object_key`, cunoscut doar pe server);
 * orice altă cale (playlist/segmente HLS, în viitor) se rezolvă strict în
 * directorul piesei.
 */
export function musicStreamTarget(objectUrl: string, relativePath: string): string | null {
    if (relativePath === MUSIC_STREAM_FILE) return objectUrl;
    return resolveEpisodeMediaUrl(objectUrl, relativePath);
}
