/**
 * Licențe audio: ce poate rula într-o platformă monetizată (feed cu reclame,
 * deblocări, comerț) și ce poate fi sincronizat pe video (reels).
 *
 * Permis: catalogul propriu al artiștilor Swypik, sunete deținute de Swypik,
 * piese royalty-free cu licență comercială, domeniu public / CC0,
 * CC BY, CC BY-SA. Exclus: NC (necomercial) și ND (sincronizarea pe video e
 * adaptare). Orice licență necunoscută = NU (fail closed). Aceeași regulă ca
 * backfill-ul din migrarea 20260926_0042.
 */
const COMMERCIAL_CODES = new Set([
    "swypik-artist",
    // Sunete create/comandate de Swypik și piese royalty-free cu licență comercială + sync
    // (migrarea 20260928_20; cum se adaugă: docs/audio/sound-library.md).
    "swypik-owned",
    "royalty-free-commercial",
    "cc0",
    "public-domain",
    "publicdomain",
    "cc-by",
    "cc-by-sa",
]);
const CC_COMMERCIAL_URL = /creativecommons\.org\/(publicdomain\/zero|licenses\/by\/|licenses\/by-sa\/)/i;
const RESTRICTED = /(-nc|\/by-nc|-nd|\/by-nd)/i;

export function isCommercialLicense(license: string | null | undefined): boolean {
    if (!license) return false;
    const l = license.trim().toLowerCase();
    if (RESTRICTED.test(l)) return false;
    return COMMERCIAL_CODES.has(l) || CC_COMMERCIAL_URL.test(l);
}

/** Doar stream-uri https: pe swypik.com (https) un stream http e blocat ca mixed content. */
export function isSecureStreamUrl(url: string | null | undefined): url is string {
    return typeof url === "string" && url.trim().toLowerCase().startsWith("https://");
}
