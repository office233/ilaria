/**
 * Stocarea din spatele cache handler-ului Next (vezi ./redis-cache-handler.cjs).
 *
 * Redis = cache-ul partajat de toate replicile web. Dacă Redis lipsește sau
 * cade, trecem pe un LRU în memorie (per replică) — degradare grațioasă: siteul
 * merge, doar invalidările (`revalidateTag`/`revalidatePath`) nu mai ajung la
 * celelalte replici până revine Redis. Un „circuit breaker” evită să plătim
 * timeout-ul Redis la fiecare cerere cât timp e jos.
 *
 * CommonJS pur (fără TypeScript/alias-uri): Next îl încarcă direct din
 * `.next/standalone` la runtime, iar build-trace-ul îl include automat.
 */
"use strict";

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_BREAKER_MS = 30_000;
const DEFAULT_MEMORY_ENTRIES = 500;

/** JSON care păstrează Buffer-ele (body/rscData) și Map-urile (segmentData) din valorile Next. */
function serialize(value) {
  return JSON.stringify(value, function replacer(key, v) {
    const original = this[key];
    if (Buffer.isBuffer(original)) return { __b64: original.toString("base64") };
    if (original instanceof Map) return { __map: Array.from(original.entries()) };
    return v;
  });
}

function deserialize(text) {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === "object") {
      if (typeof v.__b64 === "string") return Buffer.from(v.__b64, "base64");
      if (Array.isArray(v.__map)) return new Map(v.__map);
    }
    return v;
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("next-cache: redis timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class MemoryLru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(key) {
    this.map.delete(key);
  }
}

/**
 * @param {object} opts
 * @param {() => any} [opts.getClient] ioredis (sau compatibil); `null` → doar memorie
 * @param {string} opts.prefix prefix de chei (include BUILD_ID)
 */
function createStore(opts) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const breakerMs = opts.breakerMs || DEFAULT_BREAKER_MS;
  const memory = new MemoryLru(opts.memoryEntries || DEFAULT_MEMORY_ENTRIES);
  const memoryTags = new Map();
  const tagsKey = `${opts.prefix}__tags`;
  const log = opts.log || (() => {});
  let downUntil = 0;
  let client;

  function redis() {
    if (Date.now() < downUntil) return null;
    if (client === undefined) {
      try {
        client = opts.getClient ? opts.getClient() : null;
      } catch (err) {
        log("client init failed", err);
        client = null;
      }
    }
    return client;
  }

  function trip(err) {
    if (Date.now() >= downUntil) log("redis unavailable — memory fallback", err);
    downUntil = Date.now() + breakerMs;
  }

  async function call(fn) {
    const c = redis();
    if (!c) return { ok: false };
    try {
      return { ok: true, value: await withTimeout(fn(c), timeoutMs) };
    } catch (err) {
      trip(err);
      return { ok: false };
    }
  }

  return {
    mode() {
      return redis() ? "redis" : "memory";
    },
    async getEntry(key) {
      const res = await call((c) => c.get(opts.prefix + key));
      if (!res.ok) return memory.get(key) || null;
      return res.value ? deserialize(res.value) : null;
    },
    async setEntry(key, entry, ttlSeconds) {
      const res = await call((c) => c.set(opts.prefix + key, serialize(entry), "EX", Math.max(1, Math.floor(ttlSeconds))));
      // Memoria locală se umple DOAR cât Redis e jos: o copie locală făcută cât
      // Redis mergea n-ar vedea invalidările venite ulterior de pe alte replici.
      if (res.ok) memory.delete(key);
      else memory.set(key, entry);
    },
    async deleteEntry(key) {
      memory.delete(key);
      await call((c) => c.del(opts.prefix + key));
    },
    /** Momentul (ms) ultimei invalidări pentru fiecare tag (0 dacă niciodată). */
    async tagTimes(tags) {
      if (tags.length === 0) return [];
      const local = tags.map((t) => memoryTags.get(t) || 0);
      const res = await call((c) => c.hmget(tagsKey, ...tags));
      if (!res.ok) return local;
      return res.value.map((v, i) => Math.max(Number(v) || 0, local[i]));
    },
    async markTags(tags, at) {
      for (const t of tags) memoryTags.set(t, at);
      if (tags.length === 0) return;
      const args = [];
      for (const t of tags) args.push(t, String(at));
      await call((c) => c.hset(tagsKey, ...args));
    },
  };
}

module.exports = { createStore, serialize, deserialize, MemoryLru };
