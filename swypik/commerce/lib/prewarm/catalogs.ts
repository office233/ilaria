/**
 * Cataloagele externe ținute calde în Redis. Cron-ul `prewarm-catalogs`
 * (la 15 min, lock distribuit) le reîmprospătează; cererile citesc DOAR copia
 * caldă și nu așteaptă niciodată API-ul extern:
 *   - copie existentă (chiar veche) → servită imediat; dacă e „stale” (> 2×
 *     intervalul, cron oprit) se declanșează o reîmprospătare în fundal;
 *   - fără copie (prima pornire, Redis golit) → fallback-ul static (radiourile
 *     curatoriate / listă goală) + reîmprospătare în fundal.
 * Un eșec extern nu suprascrie niciodată o copie bună (serve stale on failure).
 */
import type { AudioItemDto } from "@/lib/audio/types";
import { fetchRomanianStations, fetchTopGlobalStations } from "@/lib/audio/radio-browser";
import { CURATED_ROMANIAN_STATIONS } from "@/lib/audio/radio-curated";
import { fetchAudiusTrending } from "@/lib/audio/audius";
import { fetchJamendoChill, isJamendoConfigured } from "@/lib/audio/jamendo";
import { getTrendingPodcasts } from "@/lib/audio/podcast";
import { isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import { prewarmConfig } from "./config";
import { isStale, readWarm, tryRefreshLock, writeWarm } from "./warm-store";

type CatalogSpec = {
    /** Apel extern; `null`/listă goală = eșec → copia veche rămâne. */
    fetch: () => Promise<AudioItemDto[] | null>;
    /** Ce primește cererea când nu există încă nicio copie caldă. */
    fallback: () => AudioItemDto[];
    enabled: () => boolean;
};

const music = () => isEnabled("music");

export const CATALOGS = {
    "radio:ro": { fetch: () => fetchRomanianStations(40), fallback: () => CURATED_ROMANIAN_STATIONS, enabled: music },
    "radio:global": { fetch: () => fetchTopGlobalStations(24), fallback: () => [], enabled: music },
    "audius:trending": { fetch: () => fetchAudiusTrending(25), fallback: () => [], enabled: music },
    "jamendo:chill": {
        fetch: () => fetchJamendoChill(25),
        fallback: () => [],
        enabled: () => music() && isJamendoConfigured(),
    },
    "podcasts:trending": {
        fetch: async () => {
            const items = await getTrendingPodcasts();
            return items.length ? items : null;
        },
        fallback: () => [],
        enabled: music,
    },
} as const satisfies Record<string, CatalogSpec>;

export type CatalogName = keyof typeof CATALOGS;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms).unref?.()),
    ]);
}

/** Reîmprospătează o sursă; întoarce câte elemente a scris sau `null` (copia veche rămâne). */
export async function refreshCatalog(name: CatalogName): Promise<number | null> {
    const spec: CatalogSpec = CATALOGS[name];
    const items = await withTimeout(spec.fetch(), prewarmConfig.fetchTimeoutMs());
    if (!items || items.length === 0) return null;
    await writeWarm(name, items);
    return items.length;
}

function refreshInBackground(name: CatalogName): void {
    void tryRefreshLock(name)
        .then((locked) => (locked ? refreshCatalog(name) : null))
        .catch((err: unknown) => logger.warn({ err, name }, "[prewarm] background refresh failed"));
}

/** Calea cererii: copia caldă, niciodată un apel extern sincron. */
export async function getWarmCatalog(name: CatalogName): Promise<AudioItemDto[]> {
    const spec: CatalogSpec = CATALOGS[name];
    const entry = await readWarm<AudioItemDto[]>(name);
    if (!entry) {
        refreshInBackground(name);
        return spec.fallback();
    }
    if (isStale(entry)) refreshInBackground(name);
    return entry.data;
}

export type CatalogReport = Record<string, { status: "ok" | "kept" | "error" | "disabled"; count?: number; error?: string }>;

/** Rularea cron-ului: toate sursele active, în paralel, fiecare cu timeout. */
export async function refreshAllCatalogs(): Promise<CatalogReport> {
    const names = Object.keys(CATALOGS) as CatalogName[];
    const report: CatalogReport = {};
    await Promise.all(
        names.map(async (name) => {
            const spec: CatalogSpec = CATALOGS[name];
            if (!spec.enabled()) {
                report[name] = { status: "disabled" };
                return;
            }
            try {
                const count = await refreshCatalog(name);
                report[name] = count === null ? { status: "kept" } : { status: "ok", count };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn({ err, name }, "[prewarm] refresh failed — serving the previous copy");
                report[name] = { status: "error", error: message.slice(0, 200) };
            }
        }),
    );
    return report;
}
