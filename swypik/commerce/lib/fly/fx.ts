/**
 * FX pentru Swypik Fly — convertim prețurile furnizorilor (EUR/GBP/USD…) în
 * RON, ca tot ce vede și plătește clientul român să fie în lei.
 *
 * - Sursă: frankfurter.app (cursuri ECB, gratuit, fără cheie).
 * - Cache: memorie 6h + fallback Redis 24h + fallback DB + fallback env.
 * - Buffer de siguranță FLY_FX_BUFFER_PCT (default 1.5%) — acoperă fluctuația
 *   de curs între afișare și plata către furnizor, ca să nu vindem în pierdere.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { dbQuery } from "@/lib/db";

export const DISPLAY_CURRENCY = "RON";

type RateTable = { rates: Record<string, number>; fetchedAt: number };
let memRates: RateTable | null = null;
const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const REDIS_KEY = "fly:fx:ron";
const REDIS_TTL_S = 24 * 60 * 60;

function bufferMultiplier(): number {
    const pct = Number(process.env.FLY_FX_BUFFER_PCT ?? "1.5");
    return 1 + (Number.isFinite(pct) ? pct : 1.5) / 100;
}

async function fetchLiveRates(): Promise<Record<string, number> | null> {
    // Fix 2026-08-10: timeout-ul de 5s cădea frecvent (loguri pline de
    // TimeoutError în fly-price-watch). Acum: 10s + un retry; fallback-urile
    // (Redis 24h / DB / env) rămân neschimbate, deci eșecul e oricum non-fatal.
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await fetch("https://api.frankfurter.app/latest?from=RON&to=EUR,GBP,USD,CHF", {
                signal: AbortSignal.timeout(10_000),
            });
            if (!r.ok) return null;
            const j = (await r.json()) as { rates?: Record<string, number> };
            if (!j.rates) return null;
            // frankfurter dă RON→X; noi vrem X→RON, deci inversăm.
            const out: Record<string, number> = { RON: 1 };
            for (const [cur, v] of Object.entries(j.rates)) {
                if (v > 0) out[cur] = 1 / v;
            }
            return out;
        } catch (err) {
            if (attempt === 2) {
                logger.warn({ err }, "fly fx: live rate fetch failed");
                return null;
            }
        }
    }
    return null;
}

/** Query DB table fx_rates for stored rates (cron updates these). */
async function getDbRates(): Promise<Record<string, number> | null> {
    try {
        const { rows } = await dbQuery<{ quote: string; rate: number }>(
            `SELECT quote, rate FROM fx_rates WHERE base = 'EUR' AND quote != 'EUR' LIMIT 10`,
        );
        if (!rows.length) return null;
        const out: Record<string, number> = { RON: 1 };
        for (const row of rows) {
            if (row.rate > 0) out[row.quote] = row.rate;
        }
        return Object.keys(out).length > 1 ? out : null;
    } catch (err) {
        logger.warn({ err }, "fly fx: db rate query failed");
        return null;
    }
}

async function getRates(): Promise<Record<string, number>> {
    if (memRates && Date.now() - memRates.fetchedAt < MEM_TTL_MS) return memRates.rates;

    const live = await fetchLiveRates();
    if (live) {
        memRates = { rates: live, fetchedAt: Date.now() };
        if (process.env.REDIS_URL) {
            try {
                await getRedis().set(REDIS_KEY, JSON.stringify(live), "EX", REDIS_TTL_S);
            } catch { /* non-fatal */ }
        }
        return live;
    }

    if (process.env.REDIS_URL) {
        try {
            const raw = await getRedis().get(REDIS_KEY);
            if (raw) {
                const cached = JSON.parse(raw) as Record<string, number>;
                memRates = { rates: cached, fetchedAt: Date.now() };
                return cached;
            }
        } catch { /* non-fatal */ }
    }

    // Fallback to DB (cron updates fx_rates table)
    const dbRates = await getDbRates();
    if (dbRates) {
        logger.info("fly fx: using DB fallback rates");
        memRates = { rates: dbRates, fetchedAt: Date.now() };
        return dbRates;
    }

    // Final fallback: env var with JSON rates (should be configured in prod)
    const envRates = process.env.FX_FALLBACK_RATES;
    if (envRates) {
        try {
            const parsed = JSON.parse(envRates) as Record<string, number>;
            if (Object.keys(parsed).length > 0) {
                logger.warn("fly fx: using env FX_FALLBACK_RATES");
                return { ...parsed, RON: 1 };
            }
        } catch (err) {
            logger.warn({ err }, "fly fx: failed to parse FX_FALLBACK_RATES env var");
        }
    }

    // Absolute fallback: throw error instead of using hardcoded rates
    logger.error("fly fx: NO RATES AVAILABLE — fetch failed, Redis/DB unavailable, FX_FALLBACK_RATES not configured");
    throw new Error("fx: unable to fetch or load rates — service degraded, refusing to convert");
}

/**
 * Convertește cenți dintr-o monedă furnizor în bani (RON cents), cu buffer.
 * RON→RON trece nemodificat (fără buffer).
 * Throws if currency rate cannot be determined.
 */
export async function toRonCents(cents: number, currency: string): Promise<number> {
    const cur = currency.toUpperCase();
    if (cur === "RON") return cents;
    const rates = await getRates();
    const rate = rates[cur];
    if (!rate) {
        logger.error({ currency: cur, availableRates: Object.keys(rates) }, "fly fx: unknown or missing currency rate");
        throw new Error(`fx: currency ${cur} rate not available`);
    }
    return Math.ceil(cents * rate * bufferMultiplier());
}
