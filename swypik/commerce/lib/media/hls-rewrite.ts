/**
 * Rescrie un playlist HLS astfel încât fiecare URI (segment, sub-playlist,
 * cheie, media alternativă) să treacă prin proxy-ul nostru cu token.
 * Funcție pură: nu face rețea, nu știe de Next.
 */
const URI_ATTR = /URI="([^"]+)"/g;

export function rewriteHlsPlaylist(
    playlist: string,
    playlistUrl: string,
    toProxy: (absoluteUrl: string) => string,
): string {
    const resolve = (ref: string) => new URL(ref, playlistUrl).toString();
    return playlist
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "") return line;
            if (trimmed.startsWith("#")) {
                return line.replace(URI_ATTR, (_m, uri: string) => `URI="${toProxy(resolve(uri))}"`);
            }
            return toProxy(resolve(trimmed));
        })
        .join("\n");
}
