/**
 * Loader global pentru `next/image` (next.config.mjs → images.loaderFile).
 *
 * Imaginile NU mai trec prin optimizatorul serverului (`/_next/image` ar citi
 * bytes-ii de pe CDN și i-ar re-servi din aplicație — trafic plătit pe VM):
 *   - imagini de pe CDN-ul de media, cu NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM=cloudflare
 *     → Cloudflare Image Transformations pe domeniul de media
 *       (`/cdn-cgi/image/width=…,quality=…,format=auto/<cheie>`);
 *   - orice alt URL absolut → încărcat direct de browser, neschimbat;
 *   - fișiere locale din /public → servite static (cache CDN), cu `w` doar ca
 *     indiciu pentru srcset.
 *
 * `mediaImageUrl` = aceeași transformare pentru `<img>` / `<video poster>` simple.
 */
type LoaderArgs = { src: string; width: number; quality?: number };

const DEFAULT_QUALITY = 75;

function mediaBase(): string {
    return (process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function transformMode(): string {
    return (process.env.NEXT_PUBLIC_MEDIA_IMAGE_TRANSFORM || "").trim().toLowerCase();
}

function isAbsolute(src: string): boolean {
    return /^https?:\/\//i.test(src);
}

/** URL-ul `/cdn-cgi/image/…` pentru o imagine de pe CDN-ul media, sau null dacă nu se aplică. */
function cdnTransform(src: string, width: number, quality: number | undefined): string | null {
    const base = mediaBase();
    if (!base || transformMode() !== "cloudflare" || !src.startsWith(`${base}/`)) return null;
    const key = src.slice(base.length + 1);
    const w = Math.max(1, Math.round(width));
    return `${base}/cdn-cgi/image/width=${w},quality=${quality || DEFAULT_QUALITY},format=auto/${key}`;
}

/**
 * Poster / thumbnail pentru `<img>` sau `<video poster>`: AVIF/WebP la lățimea
 * cerută când transformările sunt active; altfel URL-ul neschimbat (inclusiv
 * căile relative și gazdele din afara CDN-ului media).
 */
export function mediaImageUrl(src: string, width: number, quality?: number): string {
    if (!isAbsolute(src)) return src;
    return cdnTransform(src, width, quality) ?? src;
}

export default function mediaImageLoader({ src, width, quality }: LoaderArgs): string {
    if (!isAbsolute(src)) {
        return `${src}${src.includes("?") ? "&" : "?"}w=${width}`;
    }
    return cdnTransform(src, width, quality) ?? src;
}
