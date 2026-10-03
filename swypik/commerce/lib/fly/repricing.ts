/**
 * Repricing automat Swypik Fly.
 *
 * fly_route_markup ține marja per rută (bani RON), scrisă de cron-ul
 * fly-price-watch când piața ne bate. searchFlights() o aplică peste ofertele
 * furnizorului în locul marjei standard. Limite:
 *   - minim: FLY_MARKUP_MIN_CENTS (default 300 = 3 lei) — nu vindem sub cost
 *   - maxim: marja standard (nu creștem niciodată peste ce promitem public)
 * Cache în memorie 5 min ca să nu lovim DB la fiecare căutare.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { broadcastCacheInvalidate, onCacheInvalidate } from "@/lib/cache/invalidation";

// 5 min în producție; în dev fără cache ca să vezi efectul imediat.
const CACHE_TTL_MS = process.env.NODE_ENV === "production" ? 5 * 60 * 1000 : 0;
let cache: { map: Map<string, number>; loadedAt: number } | null = null;
// Cu N replici web, scrierea (cron-ul fly-price-watch) invalidează cache-ul pe
// TOATE replicile prin Redis (lib/cache/invalidation.ts), nu doar pe cea curentă.
const CACHE_NAME = "fly:route-markup";
const resetCache = () => {
    cache = null;
};

export function minMarkupRonCents(): number {
    // Podea 12 lei: acoperă Stripe (~7,5 lei pe un bilet mediu) + TVA pe marjă
    // + impozite și lasă profit. Sub asta repricing-ul NU coboară.
    const v = Number(process.env.FLY_MARKUP_MIN_CENTS ?? 1200);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 1200;
}

async function loadMap(): Promise<Map<string, number>> {
    onCacheInvalidate(CACHE_NAME, resetCache);
    if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.map;
    const map = new Map<string, number>();
    try {
        const { rows } = await dbQuery<{ origin: string; destination: string; markup_ron_cents: number }>(
            `SELECT origin, destination, markup_ron_cents FROM fly_route_markup`,
        );
        for (const r of rows) map.set(`${r.origin}-${r.destination}`, r.markup_ron_cents);
    } catch (err) {
        logger.warn({ err }, "fly repricing: load failed (folosim marja standard)");
    }
    cache = { map, loadedAt: Date.now() };
    return map;
}

/** Marja per rută în bani RON, sau null dacă nu există override. */
export async function getRouteMarkupRonCents(origin: string, destination: string): Promise<number | null> {
    const map = await loadMap();
    return map.get(`${origin.toUpperCase()}-${destination.toUpperCase()}`) ?? null;
}

/** Scrie/actualizează marja pe rută (folosit de cron). */
export async function setRouteMarkup(
    origin: string,
    destination: string,
    markupRonCents: number,
    reason: string,
): Promise<void> {
    const clamped = Math.max(minMarkupRonCents(), Math.round(markupRonCents));
    await dbQuery(
        `INSERT INTO fly_route_markup (origin, destination, markup_ron_cents, reason, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (origin, destination)
         DO UPDATE SET markup_ron_cents = EXCLUDED.markup_ron_cents,
                       reason = EXCLUDED.reason, updated_at = NOW()`,
        [origin.toUpperCase(), destination.toUpperCase(), clamped, reason],
    );
    await broadcastCacheInvalidate(CACHE_NAME); // pe toate replicile
}

/** Șterge override-ul (revenim la marja standard). */
export async function clearRouteMarkup(origin: string, destination: string): Promise<void> {
    await dbQuery(`DELETE FROM fly_route_markup WHERE origin = $1 AND destination = $2`, [
        origin.toUpperCase(),
        destination.toUpperCase(),
    ]);
    await broadcastCacheInvalidate(CACHE_NAME);
}
