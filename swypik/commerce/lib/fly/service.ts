/**
 * Swypik Fly — agregator peste furnizori (Duffel + Kiwi).
 *
 * - search(): interoghează în paralel toți furnizorii configurați, dedupe pe
 *   (carrier + numere de zbor + oră plecare), sortare după preț.
 * - Ofertele sunt cache-uite în Redis 15 min sub o cheie proprie, ca la
 *   checkout să nu ne bazăm pe payload-ul trimis de client (preț autoritar
 *   server-side). Înainte de plată se face priceCheck() live.
 */
import { createHash, randomUUID } from "crypto";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { intEnv } from "@/lib/config/env";
import { duffelProvider } from "./duffel";
import { getRouteMarkupRonCents } from "./repricing";
import { kiwiProvider } from "./kiwi";

import {
    CreateOrderInput,
    CreateOrderResult,
    FlightOffer,
    FlightProvider,
    FlightSearchParams,
    PriceCheckResult,
    ProviderId,
} from "./types";

const PROVIDERS: FlightProvider[] = [duffelProvider, kiwiProvider];
const CACHE_TTL_SECONDS = 15 * 60;
const cacheKey = (token: string) => `fly:offer:${token}`;
const searchCacheTtlSeconds = () => intEnv("FLY_SEARCH_CACHE_TTL_SECONDS", 60, 5, 300);
const searchCacheKey = (params: FlightSearchParams) => {
    const stable = JSON.stringify({
        origin: params.origin,
        destination: params.destination,
        departDate: params.departDate,
        returnDate: params.returnDate ?? null,
        adults: params.adults,
        children: params.children,
        infants: params.infants,
        cabin: params.cabin,
        currency: params.currency,
        maxResults: params.maxResults ?? 200,
        providers: activeProviders().map((p) => p.id).sort(),
    });
    return `fly:search:v1:${createHash("sha256").update(stable).digest("hex")}`;
};

/**
 * Fallback in-memory pentru cazul în care Redis lipsește (dev) sau pică.
 * Fără el, checkout-ul ar răspunde mereu "ofertă expirată".
 * În producdev cu mai multe instanțe, Redis rămâne sursa principală.
 */
const memCache = new Map<string, { offer: FlightOffer; expiresAt: number }>();
const searchMemCache = new Map<string, { result: SearchResult; expiresAt: number }>();
const searchInflight = new Map<string, Promise<SearchResult>>();

function memSet(token: string, offer: FlightOffer): void {
    memCache.set(token, { offer, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    if (memCache.size > 5000) {
        const now = Date.now();
        for (const [k, v] of memCache) if (v.expiresAt < now) memCache.delete(k);
    }
}

function memGet(token: string): FlightOffer | null {
    const hit = memCache.get(token);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
        memCache.delete(token);
        return null;
    }
    return hit.offer;
}

export function activeProviders(): FlightProvider[] {
    return PROVIDERS.filter((p) => p.isConfigured());
}

function dedupeKey(o: FlightOffer): string {
    const legs = o.slices
        .flatMap((s) => s.segments.map((g) => `${g.carrier}${g.flightNumber}@${g.departAt}`))
        .join("|");
    return legs || o.offerId;
}

export type SearchResult = {
    offers: (FlightOffer & { token: string })[];
    providers: ProviderId[];
    errors: { provider: ProviderId; message: string }[];
};

export async function searchFlights(params: FlightSearchParams): Promise<SearchResult> {
    const providers = activeProviders();
    const errors: SearchResult["errors"] = [];

    const settled = await Promise.allSettled(providers.map((p) => p.search(params)));
    const all: FlightOffer[] = [];
    settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
            all.push(...r.value);
        } else {
            errors.push({ provider: providers[i].id, message: String(r.reason?.message ?? r.reason) });
            logger.warn({ provider: providers[i].id, err: r.reason }, "fly provider search error");
        }
    });

    // Dedupe: pentru zboruri identice păstrăm oferta cea mai ieftină.
    const best = new Map<string, FlightOffer>();
    for (const o of all) {
        const k = dedupeKey(o);
        const existing = best.get(k);
        if (!existing || o.totalCents < existing.totalCents) best.set(k, o);
    }

    // Repricing: dacă avem marjă redusă pe rută (piața ne-a bătut), o aplicăm
    // în locul marjei standard — clientul vede direct prețul mai mic.
    let adjusted = [...best.values()];
    try {
        const override = await getRouteMarkupRonCents(params.origin, params.destination);
        if (override !== null) {
            adjusted = adjusted.map((o) => ({
                ...o,
                totalCents: o.totalCents - o.markupCents + override,
                markupCents: override,
            }));
        }
    } catch (err) {
        logger.warn({ err }, "fly: route markup lookup failed (marja standard)");
    }

    const sorted = adjusted.sort((a, b) => a.totalCents - b.totalCents);
    const withTokens = await Promise.all(
        sorted.slice(0, params.maxResults ?? 200).map(async (o) => {
            const token = randomUUID();
            await cacheOffer(token, o);
            return { ...o, token };
        }),
    );

    return { offers: withTokens, providers: providers.map((p) => p.id), errors };
}

/**
 * Short-lived search-result cache + in-process single-flight.
 * Revalidation before payment remains mandatory via priceCheck(), so a short
 * cache dramatically reduces provider cost without making checkout trust stale prices.
 */
export async function searchFlightsCached(params: FlightSearchParams): Promise<SearchResult> {
    const key = searchCacheKey(params);
    const now = Date.now();

    if (process.env.REDIS_URL) {
        try {
            const raw = await getRedis().get(key);
            if (raw) return JSON.parse(raw) as SearchResult;
        } catch (err) {
            logger.warn({ err }, "fly: search cache read failed");
        }
    }

    const mem = searchMemCache.get(key);
    if (mem && mem.expiresAt > now) return mem.result;
    if (mem) searchMemCache.delete(key);

    const pending = searchInflight.get(key);
    if (pending) return pending;

    const run = searchFlights(params)
        .then(async (result) => {
            const ttl = searchCacheTtlSeconds();
            searchMemCache.set(key, { result, expiresAt: Date.now() + ttl * 1000 });
            if (searchMemCache.size > 500) {
                const cutoff = Date.now();
                for (const [cacheEntryKey, value] of searchMemCache) {
                    if (value.expiresAt <= cutoff) searchMemCache.delete(cacheEntryKey);
                }
            }
            if (process.env.REDIS_URL) {
                try {
                    await getRedis().set(key, JSON.stringify(result), "EX", ttl);
                } catch (err) {
                    logger.warn({ err }, "fly: search cache write failed");
                }
            }
            return result;
        })
        .finally(() => {
            searchInflight.delete(key);
        });
    searchInflight.set(key, run);
    return run;
}

export async function cacheOffer(token: string, offer: FlightOffer): Promise<void> {
    memSet(token, offer);
    if (!process.env.REDIS_URL) return; // dev fără Redis — doar memorie
    try {
        const redis = getRedis();
        await redis.set(cacheKey(token), JSON.stringify(offer), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
        logger.warn({ err }, "fly: offer cache write failed (fallback memorie)");
    }
}

export async function getCachedOffer(token: string): Promise<FlightOffer | null> {
    if (process.env.REDIS_URL) {
        try {
            const redis = getRedis();
            const raw = await redis.get(cacheKey(token));
            if (raw) return JSON.parse(raw) as FlightOffer;
        } catch (err) {
            logger.warn({ err }, "fly: offer cache read failed (fallback memorie)");
        }
    }
    return memGet(token);
}

function providerFor(id: ProviderId): FlightProvider {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) throw new Error(`unknown flight provider: ${id}`);
    return p;
}

/**
 * Live Price Check — obligatoriu înainte de orice plată.
 * Reîmprospătează și cache-ul, ca oferta plătită să fie cea revalidată.
 */
export async function priceCheck(token: string): Promise<PriceCheckResult & { token: string }> {
    const cached = await getCachedOffer(token);
    if (!cached) return { ok: false, reason: "expired", token };
    const result = await providerFor(cached.provider).priceCheck(cached);
    if (result.ok && result.offer) {
        // Păstrăm marja pe rută (repricing) și la revalidare, altfel clientul
        // ar vedea artificial "prețul a crescut" la checkout.
        try {
            const slice = result.offer.slices[0];
            const override = slice
                ? await getRouteMarkupRonCents(slice.origin, slice.destination)
                : null;
            if (override !== null && result.offer.markupCents !== override) {
                const adjusted = {
                    ...result.offer,
                    totalCents: result.offer.totalCents - result.offer.markupCents + override,
                    markupCents: override,
                };
                const delta = adjusted.totalCents - cached.totalCents;
                await cacheOffer(token, adjusted);
                return {
                    ...result,
                    offer: adjusted,
                    deltaCents: delta,
                    reason: delta !== 0 ? "price_changed" : undefined,
                    token,
                };
            }
        } catch { /* marja standard */ }
        await cacheOffer(token, result.offer);
    }
    return { ...result, token };
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    return providerFor(input.offer.provider).createOrder(input);
}
