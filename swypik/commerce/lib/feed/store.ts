/**
 * Starea de servire a feed-ului în Redis (degradare grațioasă fără Redis):
 *   feed:seen:{identitate}          ZSET id → timestamp servire (TTL, plafonat)
 *   feed:snap:{identitate}:{snap}   lista clasată (JSON) pentru paginare cu cursor
 * Identitatea = `u:<userId>` sau `s:<feed_sid>`; snapshot-urile sunt legate de
 * identitate, deci un cursor furat nu citește feed-ul altcuiva.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export interface FeedStore {
  /** Clipurile servite recent, cele mai noi primele. */
  getSeen(identity: string, max: number): Promise<string[]>;
  markSeen(identity: string, ids: readonly string[], ttlSeconds: number, max: number): Promise<void>;
  saveSnapshot(identity: string, snapId: string, ids: readonly string[], ttlSeconds: number): Promise<void>;
  loadSnapshot(identity: string, snapId: string): Promise<string[] | null>;
}

const OP_TIMEOUT_MS = 300;

function withTimeout<T>(p: Promise<T>, fallback: T, op: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), OP_TIMEOUT_MS);
  });
  const guarded = p.catch((err: unknown) => {
    logger.warn({ err, op }, "[feed/store] redis op failed");
    return fallback;
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

const seenKey = (identity: string) => `feed:seen:${identity}`;
const snapKey = (identity: string, snapId: string) => `feed:snap:${identity}:${snapId}`;

export const redisFeedStore: FeedStore = {
  getSeen(identity, max) {
    return withTimeout(
      (async () => getRedis().zrevrange(seenKey(identity), 0, Math.max(0, max - 1)))(),
      [] as string[],
      "getSeen",
    );
  },
  markSeen(identity, ids, ttlSeconds, max) {
    if (ids.length === 0) return Promise.resolve();
    return withTimeout(
      (async () => {
        const now = Date.now();
        const key = seenKey(identity);
        const args: (string | number)[] = [];
        for (const id of ids) args.push(now, id);
        await getRedis()
          .multi()
          .zadd(key, ...args)
          .zremrangebyrank(key, 0, -(Math.max(1, max) + 1))
          .expire(key, Math.max(60, Math.trunc(ttlSeconds)))
          .exec();
      })(),
      undefined,
      "markSeen",
    );
  },
  saveSnapshot(identity, snapId, ids, ttlSeconds) {
    return withTimeout(
      (async () => {
        await getRedis().set(snapKey(identity, snapId), JSON.stringify(ids), "EX", Math.max(60, Math.trunc(ttlSeconds)));
      })(),
      undefined,
      "saveSnapshot",
    );
  },
  loadSnapshot(identity, snapId) {
    return withTimeout(
      (async () => {
        const raw = await getRedis().get(snapKey(identity, snapId));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
      })(),
      null,
      "loadSnapshot",
    );
  },
};

/** Store în memorie (teste / dezvoltare locală fără Redis). */
export function createMemoryFeedStore(): FeedStore {
  const seen = new Map<string, Map<string, number>>();
  const snaps = new Map<string, string[]>();
  let clock = 0;
  return {
    async getSeen(identity, max) {
      const m = seen.get(identity);
      if (!m) return [];
      return Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([id]) => id);
    },
    async markSeen(identity, ids, _ttl, max) {
      const m = seen.get(identity) ?? new Map<string, number>();
      for (const id of ids) m.set(id, ++clock);
      const trimmed = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, max);
      seen.set(identity, new Map(trimmed));
    },
    async saveSnapshot(identity, snapId, ids) {
      snaps.set(`${identity}:${snapId}`, [...ids]);
    },
    async loadSnapshot(identity, snapId) {
      return snaps.get(`${identity}:${snapId}`) ?? null;
    },
  };
}
