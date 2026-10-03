/**
 * Agregarea Web Vitals în Redis (server). Per (rută, metrică) o listă cu ultimele
 * `samplesPerSeries` valori (LPUSH + LTRIM) → p75 calculat la citire; un ZSET cu
 * numărul de eșantioane per rută mărginește cardinalitatea (rutele noi peste
 * `maxRoutes` intră în „other”). Fără identificatori de utilizator.
 */
import { getRedis } from "@/lib/redis";
import { percentile, vitalsLimits, type VitalName } from "./vitals-config";

const PREFIX = "vitals:v1:";
const ROUTES_KEY = `${PREFIX}routes`;
export const OTHER_ROUTE = "other";

export type VitalSample = { name: VitalName; value: number; route: string };

function seriesKey(route: string, name: VitalName): string {
    return `${PREFIX}s:${route}:${name}`;
}

async function admitRoute(route: string): Promise<string> {
    const redis = getRedis();
    const [score, size] = await Promise.all([redis.zscore(ROUTES_KEY, route), redis.zcard(ROUTES_KEY)]);
    return score !== null || size < vitalsLimits.maxRoutes ? route : OTHER_ROUTE;
}

export async function recordVitals(samples: VitalSample[]): Promise<void> {
    if (samples.length === 0 || !process.env.REDIS_URL) return;
    const routes = new Map<string, string>();
    for (const s of samples) {
        if (!routes.has(s.route)) routes.set(s.route, await admitRoute(s.route));
    }
    const tx = getRedis().multi();
    for (const s of samples) {
        const route = routes.get(s.route) ?? OTHER_ROUTE;
        const key = seriesKey(route, s.name);
        tx.lpush(key, String(Math.round(s.value * 1000) / 1000));
        tx.ltrim(key, 0, vitalsLimits.samplesPerSeries - 1);
        tx.expire(key, vitalsLimits.ttlSeconds);
        tx.zincrby(ROUTES_KEY, 1, route);
    }
    tx.expire(ROUTES_KEY, vitalsLimits.ttlSeconds);
    await tx.exec();
}

export type RouteVitals = {
    route: string;
    samples: number;
    p75: Record<"LCP" | "INP" | "CLS", number | null>;
};

const CARD_METRICS = ["LCP", "INP", "CLS"] as const;

/** Rutele cu cele mai multe eșantioane, cu p75 pentru LCP/INP/CLS. */
export async function getVitalsSummary(limit = 15): Promise<RouteVitals[]> {
    if (!process.env.REDIS_URL) return [];
    const redis = getRedis();
    const flat = await redis.zrevrange(ROUTES_KEY, 0, limit - 1, "WITHSCORES");
    const top: Array<{ route: string; samples: number }> = [];
    for (let i = 0; i + 1 < flat.length; i += 2) top.push({ route: flat[i], samples: Number(flat[i + 1]) });
    const pipe = redis.pipeline();
    for (const { route } of top) for (const m of CARD_METRICS) pipe.lrange(seriesKey(route, m), 0, -1);
    const results = (await pipe.exec()) ?? [];
    return top.map(({ route, samples }, i) => {
        const p75 = {} as RouteVitals["p75"];
        CARD_METRICS.forEach((m, j) => {
            const [, raw] = results[i * CARD_METRICS.length + j] ?? [null, []];
            const values = (Array.isArray(raw) ? raw : []).map(Number).filter(Number.isFinite);
            p75[m] = percentile(values, 75);
        });
        return { route, samples, p75 };
    });
}
