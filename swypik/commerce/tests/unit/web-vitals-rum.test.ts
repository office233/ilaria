/**
 * RUM propriu: normalizarea rutelor (fără identificatori), percentile, praguri,
 * ruta POST /api/vitals (validare, limite, 204) și agregarea în Redis.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rl: { success: true, remaining: 1 },
  recorded: [] as unknown[],
  zset: new Map<string, number>(),
  lists: new Map<string, string[]>(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: async () => h.rl,
  getClientIP: () => "1.2.3.4",
}));

vi.mock("@/lib/redis", () => {
  const redis = {
    zscore: async (_k: string, m: string) => (h.zset.has(m) ? String(h.zset.get(m)) : null),
    zcard: async () => h.zset.size,
    zrevrange: async () =>
      [...h.zset.entries()].sort((a, b) => b[1] - a[1]).flatMap(([m, s]) => [m, String(s)]),
    multi: () => {
      const ops: Array<() => void> = [];
      const tx = {
        lpush: (k: string, v: string) => (ops.push(() => h.lists.set(k, [v, ...(h.lists.get(k) ?? [])])), tx),
        ltrim: (k: string, _s: number, e: number) => (ops.push(() => h.lists.set(k, (h.lists.get(k) ?? []).slice(0, e + 1))), tx),
        expire: () => tx,
        zincrby: (_k: string, n: number, m: string) => (ops.push(() => h.zset.set(m, (h.zset.get(m) ?? 0) + n)), tx),
        exec: async () => ops.forEach((op) => op()),
      };
      return tx;
    },
    pipeline: () => {
      const keys: string[] = [];
      const p = {
        lrange: (k: string) => (keys.push(k), p),
        exec: async () => keys.map((k) => [null, h.lists.get(k) ?? []]),
      };
      return p;
    },
  };
  return { getRedis: () => redis };
});

import { normalizeRoute, percentile, rateVital, vitalsLimits } from "@/lib/perf/vitals-config";
import { getVitalsSummary, recordVitals } from "@/lib/perf/vitals-store";
import { POST } from "@/app/api/vitals/route";

beforeEach(() => {
  process.env.REDIS_URL = "redis://fake";
  h.rl = { success: true, remaining: 1 };
  h.zset.clear();
  h.lists.clear();
});

describe("normalizeRoute", () => {
  it("scoate limba, query-ul și identificatorii", () => {
    expect(normalizeRoute("/ro/product/7f1c2b9e-1111-4222-8333-444455556666?x=1")).toBe("/product/:id");
    expect(normalizeRoute("/en/music/track/kiss-fm-2")).toBe("/music/track/:id");
    expect(normalizeRoute("/orders/12345")).toBe("/orders/:id");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/de")).toBe("/");
    expect(normalizeRoute("/explore")).toBe("/explore");
  });

  it("mărginește adâncimea și elimină caracterele ciudate", () => {
    expect(normalizeRoute("/a/b/c/d/e/f")).toBe("/a/b/c/d");
    expect(normalizeRoute("/<script>")).toBe("/script");
  });
});

describe("percentile + rateVital", () => {
  it("p75 prin rang cel mai apropiat", () => {
    expect(percentile([], 75)).toBeNull();
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
    expect(percentile([10, 1, 5, 7, 3, 9, 2, 8], 75)).toBe(8);
  });

  it("praguri Google", () => {
    expect(rateVital("LCP", 2400)).toBe("good");
    expect(rateVital("LCP", 3000)).toBe("needs-improvement");
    expect(rateVital("INP", 600)).toBe("poor");
    expect(rateVital("CLS", 0.05)).toBe("good");
  });
});

function post(body: unknown, raw?: string): Request {
  return new Request("http://x/api/vitals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

describe("POST /api/vitals", () => {
  it("204 și agregare per rută normalizată", async () => {
    const res = await POST(post({ metrics: [
      { name: "LCP", value: 1800, route: "/ro/product/7f1c2b9e-1111-4222-8333-444455556666" },
      { name: "CLS", value: 0.02, route: "/ro/product/abc-123" },
      { name: "INP", value: 999_999, route: "/explore" }, // peste maxim → ignorat
    ] }));
    expect(res.status).toBe(204);
    const summary = await getVitalsSummary();
    expect(summary).toEqual([{ route: "/product/:id", samples: 2, p75: { LCP: 1800, INP: null, CLS: 0.02 } }]);
  });

  it("400 pe corp invalid / metrică necunoscută / lot prea mare", async () => {
    expect((await POST(post(null, "{nope"))).status).toBe(400);
    expect((await POST(post({ metrics: [{ name: "FID", value: 1, route: "/" }] }))).status).toBe(400);
    const many = Array.from({ length: vitalsLimits.maxBatch + 1 }, () => ({ name: "LCP", value: 1, route: "/" }));
    expect((await POST(post({ metrics: many }))).status).toBe(400);
  });

  it("413 peste limita de octeți, 429 peste rata", async () => {
    expect((await POST(post(null, "x".repeat(vitalsLimits.maxBodyBytes + 1)))).status).toBe(413);
    h.rl = { success: false, remaining: 0 };
    expect((await POST(post({ metrics: [{ name: "LCP", value: 1, route: "/" }] }))).status).toBe(429);
  });
});

describe("recordVitals — cardinalitate mărginită", () => {
  it("rutele noi peste plafon intră în „other”", async () => {
    for (let i = 0; i < vitalsLimits.maxRoutes; i++) h.zset.set(`/r${i}`, 1);
    await recordVitals([{ name: "LCP", value: 100, route: "/brand-new" }]);
    expect(h.zset.has("/brand-new")).toBe(false);
    expect(h.zset.get("other")).toBe(1);
  });
});
