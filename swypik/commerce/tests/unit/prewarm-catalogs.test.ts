/**
 * Preîncălzirea cataloagelor externe (lib/prewarm/*): cererea nu așteaptă
 * niciodată sursa externă, un eșec nu suprascrie copia bună, Redis e sursa de
 * adevăr (memoria doar când Redis nu răspunde), cron-ul e autentificat + lock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const redis = {
    down: false,
    get: vi.fn(async (k: string) => {
      if (redis.down) throw new Error("redis down");
      return store.get(k) ?? null;
    }),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      if (redis.down) throw new Error("redis down");
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
      return keys.length;
    }),
  };
  return {
    store,
    redis,
    fetchRo: vi.fn(),
    fetchGlobal: vi.fn(),
    fetchAudius: vi.fn(),
    fetchJamendo: vi.fn(),
    podcasts: vi.fn(),
    runCronSkips: false,
  };
});

vi.mock("@/lib/redis", () => ({ getRedis: () => h.redis }));
vi.mock("@/lib/feature-flags", () => ({ isEnabled: () => true }));
vi.mock("@/lib/audio/radio-browser", () => ({ fetchRomanianStations: h.fetchRo, fetchTopGlobalStations: h.fetchGlobal }));
vi.mock("@/lib/audio/audius", () => ({ fetchAudiusTrending: h.fetchAudius }));
vi.mock("@/lib/audio/jamendo", () => ({ fetchJamendoChill: h.fetchJamendo, isJamendoConfigured: () => false }));
vi.mock("@/lib/audio/podcast", () => ({ getTrendingPodcasts: h.podcasts }));
vi.mock("@/lib/news/repository", () => ({ listArticles: vi.fn(async () => [{ id: "n1" }]) }));
vi.mock("@/lib/cron/runCron", () => ({
  runCron: async <T,>(_name: string, fn: () => Promise<T>) => (h.runCronSkips ? null : fn()),
  cronSkippedResponse: (job: string) => Response.json({ success: true, skipped: true, job }),
}));

import { CURATED_ROMANIAN_STATIONS } from "@/lib/audio/radio-curated";
import { getWarmCatalog, refreshAllCatalogs, refreshCatalog } from "@/lib/prewarm/catalogs";
import { __resetWarmMemory, readWarm, writeWarm, isStale } from "@/lib/prewarm/warm-store";
import { getNewsFirstPage, invalidateNewsLists, refreshNewsLists } from "@/lib/prewarm/news";
import { prewarmConfig } from "@/lib/prewarm/config";
import { GET as cronGet } from "@/app/api/cron/prewarm-catalogs/route";

const station = (id: string) => ({ id, slug: id, title: id, artist: "a", coverUrl: null, streamUrl: `https://s/${id}`, durationMs: 0, genre: "g", source: "radio" as const });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  process.env.REDIS_URL = "redis://fake";
  process.env.CRON_SECRET = "s3cret";
  h.store.clear();
  h.redis.down = false;
  h.runCronSkips = false;
  __resetWarmMemory();
  for (const fn of [h.fetchRo, h.fetchGlobal, h.fetchAudius, h.fetchJamendo, h.podcasts]) fn.mockReset();
  h.fetchRo.mockResolvedValue([station("ro1")]);
  h.fetchGlobal.mockResolvedValue([station("g1")]);
  h.fetchAudius.mockResolvedValue(null);
  h.fetchJamendo.mockResolvedValue(null);
  h.podcasts.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getWarmCatalog — calea cererii", () => {
  it("fără copie: întoarce imediat fallback-ul (curatoriatele) și reîmprospătează în fundal", async () => {
    let release: (v: unknown) => void = () => undefined;
    h.fetchRo.mockReturnValue(new Promise((r) => { release = r; }));
    const items = await getWarmCatalog("radio:ro");
    expect(items).toBe(CURATED_ROMANIAN_STATIONS); // răspuns imediat, sursa externă încă „atârnă”
    await flush();
    expect(h.fetchRo).toHaveBeenCalledTimes(1);
    release([station("ro-fresh")]);
    await flush();
    await flush();
    expect((await getWarmCatalog("radio:ro"))[0].id).toBe("ro-fresh");
  });

  it("cu copie proaspătă: nu atinge sursa externă", async () => {
    await writeWarm("radio:global", [station("g-warm")]);
    expect((await getWarmCatalog("radio:global"))[0].id).toBe("g-warm");
    expect(h.fetchGlobal).not.toHaveBeenCalled();
  });

  it("copie veche (cron oprit): o servește și declanșează o singură reîmprospătare (lock NX)", async () => {
    await writeWarm("radio:global", [station("old")], Date.now() - 3 * prewarmConfig.intervalMs());
    const [a, b] = await Promise.all([getWarmCatalog("radio:global"), getWarmCatalog("radio:global")]);
    expect(a[0].id).toBe("old");
    expect(b[0].id).toBe("old");
    await flush();
    expect(h.fetchGlobal).toHaveBeenCalledTimes(1);
  });
});

describe("refreshCatalog — serve stale on failure", () => {
  it("eșec extern (null / listă goală / excepție) păstrează copia veche", async () => {
    await writeWarm("radio:ro", [station("good")]);
    h.fetchRo.mockResolvedValueOnce(null);
    expect(await refreshCatalog("radio:ro")).toBeNull();
    h.fetchRo.mockResolvedValueOnce([]);
    expect(await refreshCatalog("radio:ro")).toBeNull();
    h.fetchRo.mockRejectedValueOnce(new Error("mirrors down"));
    await expect(refreshCatalog("radio:ro")).rejects.toThrow();
    expect((await readWarm<Array<{ id: string }>>("radio:ro"))?.data[0].id).toBe("good");
  });

  it("refreshAllCatalogs raportează per sursă", async () => {
    h.fetchAudius.mockRejectedValueOnce(new Error("boom"));
    const report = await refreshAllCatalogs();
    expect(report["radio:ro"]).toEqual({ status: "ok", count: 1 });
    expect(report["audius:trending"].status).toBe("error");
    expect(report["jamendo:chill"]).toEqual({ status: "disabled" });
    expect(report["podcasts:trending"]).toEqual({ status: "kept" });
  });
});

describe("warm-store", () => {
  it("Redis căzut → ultima copie din memoria replicii", async () => {
    await writeWarm("radio:ro", [station("mem")]);
    h.redis.down = true;
    expect((await readWarm<Array<{ id: string }>>("radio:ro"))?.data[0].id).toBe("mem");
  });

  it("cheie ștearsă în Redis (invalidare de pe altă replică) → fără copie, și memoria se golește", async () => {
    await writeWarm("news:list:all", [{ id: "retras" }]);
    h.store.clear();
    expect(await readWarm("news:list:all")).toBeNull();
    h.redis.down = true;
    expect(await readWarm("news:list:all")).toBeNull();
  });

  it("isStale după 2× interval", () => {
    const now = Date.now();
    expect(isStale({ fetchedAt: now - prewarmConfig.intervalMs(), data: 1 }, now)).toBe(false);
    expect(isStale({ fetchedAt: now - 2 * prewarmConfig.intervalMs() - 1, data: 1 }, now)).toBe(true);
  });
});

describe("liste de știri calde", () => {
  it("refresh scrie toate filtrele; invalidarea le șterge", async () => {
    const n = await refreshNewsLists();
    expect(n).toBeGreaterThan(1);
    expect(await getNewsFirstPage(null)).toEqual([{ id: "n1" }]);
    await invalidateNewsLists();
    expect([...h.store.keys()].filter((k) => k.includes("news:list"))).toEqual([]);
  });
});

describe("cron /api/cron/prewarm-catalogs", () => {
  const req = (auth?: string) => new Request("http://x/api/cron/prewarm-catalogs", { method: "POST", headers: auth ? { authorization: auth } : {} });

  it("fără secret → 401", async () => {
    expect((await cronGet(req())).status).toBe(401);
    expect((await cronGet(req("Bearer wrong!"))).status).toBe(401);
  });

  it("autorizat → rulează și raportează", async () => {
    const res = await cronGet(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalogs["radio:ro"].status).toBe("ok");
    expect(body.news.status).toBe("ok");
  });

  it("lock ținut de altă rulare → 200 skipped", async () => {
    h.runCronSkips = true;
    const body = await (await cronGet(req("Bearer s3cret"))).json();
    expect(body.skipped).toBe(true);
  });
});
