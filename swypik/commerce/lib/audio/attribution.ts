/**
 * Atribuirea cerută de licențele Creative Commons BY / BY-SA (Jamendo):
 * titlu, autor, licență (cu link) și sursa. Pur — folosit de TrackRow și
 * FullScreenPlayer. Fără licență cunoscută → null (nu inventăm o atribuire).
 */
export type TrackAttribution = { licenseName: string; licenseUrl: string; sourceName: string; sourceUrl: string | null };

const CC_URL = /^https?:\/\/(?:www\.)?creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d+(?:\.\d+)?)?/i;
const SOURCE_NAMES: Record<string, string> = { jamendo: "Jamendo", audius: "Audius" };

/** `https://creativecommons.org/licenses/by-sa/3.0/` → `CC BY-SA 3.0`; `publicdomain/zero/1.0` → `CC0 1.0`. */
export function ccLicenseName(url: string | null | undefined): string | null {
    const m = url ? CC_URL.exec(url.trim()) : null;
    if (!m) return null;
    const [, kind, code, version] = m;
    const name = kind.toLowerCase() === "publicdomain" ? (code.toLowerCase() === "zero" ? "CC0" : "Public Domain") : `CC ${code.toUpperCase()}`;
    return version ? `${name} ${version}` : name;
}

export function trackAttribution(track: { source?: string; licenseUrl?: string | null; externalUrl?: string | null }): TrackAttribution | null {
    if (!track.source || track.source === "swypik") return null;
    const licenseName = ccLicenseName(track.licenseUrl);
    if (!licenseName || !track.licenseUrl) return null;
    return {
        licenseName,
        licenseUrl: track.licenseUrl.replace(/^http:/i, "https:"),
        sourceName: SOURCE_NAMES[track.source] ?? track.source,
        sourceUrl: track.externalUrl && /^https:\/\//i.test(track.externalUrl) ? track.externalUrl : null,
    };
}
