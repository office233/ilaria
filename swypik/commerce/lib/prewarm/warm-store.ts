/**
 * Stocare „caldă” partajată între replici: Redis (JSON cu `fetchedAt`), cu o
 * oglindă în memorie a ultimei copii văzute de replica asta — dacă Redis e jos
 * sau lent, cererea primește ultima copie locală, nu așteaptă.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { prewarmConfig, WARM_KEY_PREFIX } from "./config";

export type WarmEntry<T> = { fetchedAt: number; data: T };

const memory = new Map<string, WarmEntry<unknown>>();
const UNAVAILABLE = Symbol("redis-unavailable");

function redisKey(name: string): string {
    return `${WARM_KEY_PREFIX}${name}`;
}

/** Rezultatul promisiunii sau UNAVAILABLE (eroare / peste timeout). */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof UNAVAILABLE> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(UNAVAILABLE), ms);
        p.then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(UNAVAILABLE); },
        );
    });
}

function isEntry(value: unknown): value is WarmEntry<unknown> {
    return (
        typeof value === "object" && value !== null &&
        typeof (value as { fetchedAt?: unknown }).fetchedAt === "number" &&
        "data" in value
    );
}

function fromMemory<T>(name: string): WarmEntry<T> | null {
    return (memory.get(name) as WarmEntry<T> | undefined) ?? null;
}

/**
 * Ultima copie. Redis e sursa de adevăr: o cheie lipsă (expirată sau
 * invalidată) înseamnă „nicio copie”. Memoria locală se folosește DOAR când
 * Redis lipsește sau nu răspunde la timp. Nu aruncă.
 */
export async function readWarm<T>(name: string): Promise<WarmEntry<T> | null> {
    if (!process.env.REDIS_URL) return fromMemory<T>(name);
    const raw = await settleWithin(getRedis().get(redisKey(name)), prewarmConfig.redisReadTimeoutMs());
    if (raw === UNAVAILABLE) return fromMemory<T>(name);
    if (raw === null) {
        memory.delete(name);
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isEntry(parsed)) {
            memory.set(name, parsed);
            return parsed as WarmEntry<T>;
        }
    } catch {
        // intrare coruptă — tratată ca lipsă
    }
    logger.warn({ name }, "[prewarm] corrupt warm entry ignored");
    return null;
}

export async function writeWarm<T>(name: string, data: T, now = Date.now()): Promise<void> {
    const entry: WarmEntry<T> = { fetchedAt: now, data };
    memory.set(name, entry);
    if (!process.env.REDIS_URL) return;
    await getRedis().set(redisKey(name), JSON.stringify(entry), "EX", prewarmConfig.hardTtlSeconds());
}

/** Șterge copiile (Redis + memoria replicii curente). */
export async function deleteWarm(names: string[]): Promise<void> {
    for (const name of names) memory.delete(name);
    if (!process.env.REDIS_URL || names.length === 0) return;
    await getRedis().del(...names.map(redisKey));
}

/** Lock scurt (SET NX) ca o singură replică să reîmprospăteze o sursă în fundal. */
export async function tryRefreshLock(name: string): Promise<boolean> {
    if (!process.env.REDIS_URL) return true;
    const res = await settleWithin(
        getRedis().set(`${redisKey(name)}:lock`, "1", "EX", prewarmConfig.refreshLockSeconds(), "NX"),
        prewarmConfig.redisReadTimeoutMs(),
    );
    return res === "OK";
}

export function isStale(entry: WarmEntry<unknown>, now = Date.now()): boolean {
    return now - entry.fetchedAt > 2 * prewarmConfig.intervalMs();
}

/** Doar pentru teste. */
export function __resetWarmMemory(): void {
    memory.clear();
}
