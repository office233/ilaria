/**
 * Centrul implicit al hărților (fallback când nu avem locația userului).
 * Configurabil prin env NEXT_PUBLIC_DEFAULT_MAP_CENTER="lat,lng" (inline-uit la build).
 * Default: București.
 */
function parseCenter(raw: string | undefined): { lat: number; lng: number } {
    if (raw) {
        const [lat, lng] = raw.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return { lat: 44.4268, lng: 26.1025 };
}

export const DEFAULT_MAP_CENTER = parseCenter(process.env.NEXT_PUBLIC_DEFAULT_MAP_CENTER);
