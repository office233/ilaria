/**
 * Swypik Fly — Deals Engine (prețuri "de la" pe destinațiile populare).
 * Serviciu intern partajat între /api/fly/deals și /api/trips/packages.
 * Zero apeluri HTTP către propriul host (fără loopback fetch, fără riscuri de timeout).
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { duffelProvider } from "@/lib/fly/duffel";
import { POPULAR_DESTINATIONS } from "@/lib/fly/destinations";

const TTL_SECONDS = 12 * 60 * 60;
const IATA = /^[A-Za-z]{3}$/;

export type Deal = {
    iata: string;
    city: string;
    country: string;
    image: string;
    fromCents: number | null;
    currency: string;
};

export type FlyDealsResult = {
    origin: string;
    departDate: string;
    deals: Deal[];
    cached: boolean;
};

export async function getFlyDeals(originRaw = "OTP"): Promise<FlyDealsResult> {
    const origin = IATA.test(originRaw.toUpperCase()) ? originRaw.toUpperCase() : "OTP";
    const departDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const cacheKey = `fly:deals:v2:${origin}:${departDate}`;

    if (process.env.REDIS_URL) {
        try {
            const redis = getRedis();
            const cached = await redis.get(cacheKey);
            if (cached) {
                return { origin, departDate, deals: JSON.parse(cached) as Deal[], cached: true };
            }
        } catch (err) {
            logger.warn({ err }, "fly deals: cache read failed");
        }
    }

    // Fără cheie Duffel nu interogăm nimic (înainte pleca `Bearer undefined` ×12 și cache-uia null-uri 12h).
    if (!duffelProvider.isConfigured()) {
        return { origin, departDate, deals: [], cached: false };
    }

    const targets = POPULAR_DESTINATIONS.filter((d) => d.iata !== origin);
    const results = await Promise.allSettled(
        targets.map(async (d) => {
            const offers = await duffelProvider.search({
                origin,
                destination: d.iata,
                departDate,
                adults: 1,
                cabin: "economy",
                currency: "EUR",
                maxResults: 5,
            });
            const cheapest = offers.reduce<number | null>(
                (min, o) => (min === null || o.totalCents < min ? o.totalCents : min),
                null,
            );
            return {
                iata: d.iata,
                city: d.city,
                country: d.country,
                image: d.image,
                fromCents: cheapest,
                currency: offers[0]?.currency ?? "EUR",
            } satisfies Deal;
        }),
    );

    const deals: Deal[] = results
        .map((r, i) =>
            r.status === "fulfilled"
                ? r.value
                : ({ ...targets[i], fromCents: null, currency: "EUR" } satisfies Deal),
        )
        .sort((a, b) => {
            if (a.fromCents === null) return 1;
            if (b.fromCents === null) return -1;
            return a.fromCents - b.fromCents;
        });

    if (process.env.REDIS_URL) {
        try {
            const redis = getRedis();
            await redis.set(cacheKey, JSON.stringify(deals), "EX", TTL_SECONDS);
        } catch (err) {
            logger.warn({ err }, "fly deals: cache write failed");
        }
    }

    return { origin, departDate, deals, cached: false };
}
