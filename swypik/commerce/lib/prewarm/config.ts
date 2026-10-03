/**
 * Preîncălzirea cataloagelor externe (Radio-Browser, Audius, Jamendo,
 * podcasturi) și a listelor de știri în Redis — vezi lib/prewarm/catalogs.ts
 * și cron-ul `prewarm-catalogs` (infra/hetzner/cron-worker/run.sh, 15 min).
 */
import { intEnv } from "@/lib/config/env";

export const prewarmConfig = {
    /** Intervalul cron-ului; o copie mai veche de 2× e considerată „stale”. */
    intervalMs: () => intEnv("PREWARM_INTERVAL_MS", 15 * 60_000, 60_000, 24 * 3_600_000),
    /** Cât păstrează Redis o copie (servită stale dacă sursa externă cade). */
    hardTtlSeconds: () => intEnv("PREWARM_HARD_TTL_S", 7 * 86_400, 3600, 30 * 86_400),
    /** Citirea din Redis pe calea cererii nu are voie să întârzie răspunsul. */
    redisReadTimeoutMs: () => intEnv("PREWARM_REDIS_TIMEOUT_MS", 250, 20, 5000),
    /** Timeout per sursă externă în cron (serverele Radio-Browser au mirror-uri). */
    fetchTimeoutMs: () => intEnv("PREWARM_FETCH_TIMEOUT_MS", 20_000, 1000, 120_000),
    /** Lock Redis pentru reîmprospătarea în fundal declanșată de o cerere. */
    refreshLockSeconds: () => intEnv("PREWARM_REFRESH_LOCK_S", 60, 5, 900),
} as const;

export const WARM_KEY_PREFIX = "warm:v1:";
