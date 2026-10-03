import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createStore, serialize, deserialize } = require("../../lib/next-cache/store.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Handler = require("../../lib/next-cache/redis-cache-handler.cjs");

/** Redis partajat în memorie (subsetul folosit de store). */
class FakeRedis {
  kv = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  ttl = new Map<string, number>();
  down = false;
  calls = 0;
  private guard() {
    this.calls += 1;
    if (this.down) return Promise.reject(new Error("ECONNREFUSED"));
    return null;
  }
  get(k: string) {
    return this.guard() ?? Promise.resolve(this.kv.get(k) ?? null);
  }
  set(k: string, v: string, _ex: string, ttl: number) {
    const g = this.guard();
    if (g) return g;
    this.kv.set(k, v);
    this.ttl.set(k, ttl);
    return Promise.resolve("OK");
  }
  del(k: string) {
    return this.guard() ?? Promise.resolve(this.kv.delete(k) ? 1 : 0);
  }
  hmget(key: string, ...fields: string[]) {
    const h = this.hashes.get(key) ?? new Map();
    return this.guard() ?? Promise.resolve(fields.map((f) => h.get(f) ?? null));
  }
  hset(key: string, ...args: string[]) {
    const g = this.guard();
    if (g) return g;
    const h = this.hashes.get(key) ?? new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]);
    this.hashes.set(key, h);
    return Promise.resolve(args.length / 2);
  }
}

function replica(redis: FakeRedis, opts: Record<string, unknown> = {}) {
  const store = createStore({ prefix: "next-cache:build1:", getClient: () => redis, log: () => undefined, ...opts });
  return new Handler({ store });
}

const page = (html: string, tags?: string) => ({
  kind: "APP_PAGE",
  html,
  rscData: Buffer.from(`rsc:${html}`),
  segmentData: new Map([["/seg", Buffer.from("s")]]),
  headers: tags ? { "x-next-cache-tags": tags } : {},
  status: 200,
});

describe("serializare", () => {
  it("păstrează Buffer și Map (rscData / segmentData)", () => {
    const value = page("<p>x</p>");
    const back = deserialize(serialize(value));
    expect(Buffer.isBuffer(back.rscData)).toBe(true);
    expect(back.rscData.toString()).toBe("rsc:<p>x</p>");
    expect(back.segmentData).toBeInstanceOf(Map);
    expect(back.segmentData.get("/seg").toString()).toBe("s");
  });
});

describe("RedisCacheHandler — cache partajat între replici", () => {
  it("o intrare scrisă de replica A e servită de replica B", async () => {
    const redis = new FakeRedis();
    const a = replica(redis);
    const b = replica(redis);
    await a.set("/ro/discover", page("v1"), { revalidate: 120 });
    const hit = await b.get("/ro/discover", { softTags: ["_N_T_/ro/discover"] });
    expect(hit.value.html).toBe("v1");
    expect(redis.ttl.get("next-cache:build1:/ro/discover")).toBe(2400); // 20 × revalidate
  });

  it("revalidateTag / revalidatePath pe replica A invalidează intrarea și pe replica B", async () => {
    const redis = new FakeRedis();
    const a = replica(redis);
    const b = replica(redis);
    await a.set("/ro/admin/sellers", page("old", "sellers"), { revalidate: false });
    await new Promise((r) => setTimeout(r, 2));
    await b.revalidateTag("_N_T_/ro/admin/sellers"); // revalidatePath → soft tag implicit
    expect(await a.get("/ro/admin/sellers", { softTags: ["_N_T_/ro/admin/sellers"] })).toBeNull();

    await a.set("/x", page("x", "sellers"), {});
    await new Promise((r) => setTimeout(r, 2));
    await b.revalidateTag(["sellers"]); // tag explicit din x-next-cache-tags
    expect(await a.get("/x", {})).toBeNull();
  });

  it("set(null) șterge intrarea", async () => {
    const redis = new FakeRedis();
    const a = replica(redis);
    await a.set("/k", page("x"), {});
    await a.set("/k", null, {});
    expect(await a.get("/k", {})).toBeNull();
  });

  it("Redis căzut → fallback pe memoria replicii, fără erori; circuit breaker oprește apelurile", async () => {
    const redis = new FakeRedis();
    const a = replica(redis, { breakerMs: 60_000 });
    redis.down = true;
    await expect(a.set("/k", page("mem"), { revalidate: 60 })).resolves.toBeUndefined();
    const callsAfterTrip = redis.calls;
    expect((await a.get("/k", {})).value.html).toBe("mem");
    await a.revalidateTag("t");
    expect(redis.calls).toBe(callsAfterTrip); // breaker deschis: nu mai lovim Redis
  });

  it("Redis lent → timeout scurt, apoi memorie", async () => {
    const slow = { get: () => new Promise(() => undefined) } as unknown as FakeRedis;
    const store = createStore({ prefix: "p:", getClient: () => slow, timeoutMs: 20, log: () => undefined });
    const started = Date.now();
    expect(await store.getEntry("k")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.mode()).toBe("memory");
  });

  it("fără REDIS_URL (client null) totul merge din memorie", async () => {
    const store = createStore({ prefix: "p:", getClient: () => null, log: () => undefined });
    const h = new Handler({ store });
    await h.set("/k", page("m"), {});
    expect((await h.get("/k", {})).value.html).toBe("m");
    expect(store.mode()).toBe("memory");
  });

  it("TTL: revalidate lipsă → maxim; mic → minim 60 s", () => {
    vi.stubEnv("NEXT_CACHE_MAX_TTL_SECONDS", "1000");
    expect(Handler.ttlFor(undefined)).toBe(1000);
    expect(Handler.ttlFor(1)).toBe(60);
    expect(Handler.ttlFor(10)).toBe(200);
    vi.unstubAllEnvs();
  });
});
