/**
 * Cache handler Next 15 partajat prin Redis (configurat în next.config.mjs,
 * împreună cu `cacheMaxMemorySize: 0`).
 *
 * De ce: fără el, ISR / `unstable_cache` / fetch cache / `revalidatePath` /
 * `revalidateTag` trăiesc pe discul și în memoria FIECĂREI replici. Cu N
 * replici, un `revalidatePath` din admin ar invalida doar replica care a
 * servit cererea — celelalte ar servi conținut vechi până la expirare.
 *
 * - intrările sunt partajate (Redis), cu prefix pe BUILD_ID: un build nou nu
 *   citește niciodată payload-uri RSC ale build-ului vechi (chunk-uri diferite);
 * - invalidarea pe tag: `revalidateTag(t)` scrie `t → now` într-un hash; la
 *   `get`, o intrare mai veche decât oricare dintre tagurile ei (explicite,
 *   `x-next-cache-tags`, sau „soft tags” implicite ale căii) e tratată ca lipsă;
 * - Redis indisponibil → LRU în memorie per replică (vezi ./store.cjs).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createStore } = require("./store.cjs");

const DAY = 86_400;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBuildId(serverDistDir) {
  try {
    if (serverDistDir) {
      const id = fs.readFileSync(path.join(serverDistDir, "..", "BUILD_ID"), "utf8").trim();
      if (id) return id;
    }
  } catch {
    /* build în curs / dev */
  }
  const commit = process.env.BUILD_COMMIT;
  return commit && commit !== "unknown" ? commit : "dev";
}

function defaultClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require("ioredis");
  const client = new IORedis(url, {
    // Fără coadă offline: cât timp Redis e jos, comenzile eșuează imediat și
    // cădem pe memorie, în loc să blocăm randarea paginii.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  client.on("error", () => {
    /* raportat de store (circuit breaker) */
  });
  return client;
}

function log(message, err) {
  const detail = err && err.message ? `: ${err.message}` : "";
  console.warn(`[next-cache] ${message}${detail}`);
}

let sharedStore = null;

/** TTL în Redis: păstrăm intrarea mult peste `revalidate` ca să poată fi servită „stale”. */
function ttlFor(revalidate) {
  const max = envNumber("NEXT_CACHE_MAX_TTL_SECONDS", 14 * DAY);
  if (typeof revalidate !== "number" || revalidate <= 0) return max;
  return Math.min(max, Math.max(60, revalidate * 20));
}

function tagsOf(value, extra) {
  const tags = new Set(extra || []);
  const header = value && value.headers && value.headers["x-next-cache-tags"];
  if (typeof header === "string") for (const t of header.split(",")) if (t) tags.add(t);
  return [...tags];
}

class RedisCacheHandler {
  /**
   * `options` vine de la Next (`serverDistDir`, `fs`, `dev`…). Store-ul e unic
   * per proces (Next instanțiază handler-ul de mai multe ori). `options.store`
   * există doar pentru teste.
   */
  constructor(options = {}) {
    if (options.store) {
      this.store = options.store;
      return;
    }
    if (!sharedStore) {
      sharedStore = createStore({
        prefix: `next-cache:${readBuildId(options.serverDistDir)}:`,
        getClient: defaultClient,
        timeoutMs: envNumber("NEXT_CACHE_REDIS_TIMEOUT_MS", 500),
        memoryEntries: envNumber("NEXT_CACHE_MEMORY_ENTRIES", 500),
        log,
      });
    }
    this.store = sharedStore;
  }

  async get(key, ctx = {}) {
    const entry = await this.store.getEntry(key);
    if (!entry) return null;
    const tags = [...new Set([...(entry.tags || []), ...(ctx.tags || []), ...(ctx.softTags || [])])];
    const times = await this.store.tagTimes(tags);
    if (times.some((t) => t > entry.lastModified)) {
      await this.store.deleteEntry(key);
      return null;
    }
    return { lastModified: entry.lastModified, value: entry.value };
  }

  async set(key, data, ctx = {}) {
    if (data === null || data === undefined) {
      await this.store.deleteEntry(key);
      return;
    }
    const entry = { value: data, lastModified: Date.now(), tags: tagsOf(data, ctx.tags) };
    const revalidate = ctx.revalidate ?? (ctx.cacheControl && ctx.cacheControl.revalidate);
    await this.store.setEntry(key, entry, ttlFor(revalidate));
  }

  async revalidateTag(tags) {
    const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
    await this.store.markTags(list, Date.now());
  }

  resetRequestCache() {}
}

module.exports = RedisCacheHandler;
module.exports.RedisCacheHandler = RedisCacheHandler;
module.exports.ttlFor = ttlFor;
module.exports._resetSharedStore = () => {
  sharedStore = null;
};
