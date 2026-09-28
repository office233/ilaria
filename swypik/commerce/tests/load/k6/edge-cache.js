/**
 * Cache-ul Cloudflare pe endpoint-urile publice cache-abile: după încălzire,
 * răspunsurile anonime ar trebui să vină cu `cf-cache-status: HIT`.
 * Raportul HIT e metrica `edge_cache_hit` (Rate); pragul (>80%) e activ doar cu
 * -e EXPECT_CF=1 — are sens numai când BASE_URL trece prin Cloudflare și există
 * reguli de cache pentru /api/* (JSON nu e cache-uit implicit de Cloudflare).
 * Cererile sunt ANONIME (fără cookie): cu cookie, feed-ul e `private` și nu se
 * cache-uiește la edge, intenționat.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke -e EXPECT_CF=1 tests/load/k6/edge-cache.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, buildOptions } from "./lib/config.js";
import { get, trackEdgeCache, warmEdge } from "./lib/http.js";

/** Endpoint-uri cu `s-maxage` / `CDN-Cache-Control` publice (vezi rutele respective). */
const CACHEABLE = [
  { path: "/api/v1/feed?limit=15&offset=0", name: "edge_feed" },
  { path: "/api/audio/feed?tab=radio", name: "edge_audio_radio" },
  { path: "/api/products?limit=20", name: "edge_products" },
];
/** Răspunsuri fără header `cf-cache-status` (ținta nu e în spatele Cloudflare). */
const noCfHeader = new Counter("edge_no_cf_header");

const latency = {};
for (const c of CACHEABLE) latency[c.name] = { p95: 300, p99: 800 };
export const options = buildOptions(latency);

export function setup() {
  warmEdge(CACHEABLE.map((c) => c.path), 3);
}

export default function iteration() {
  // Jar gol per iterație: niciun cookie setat anterior nu transformă cererea în „privată”.
  http.cookieJar().clear(BASE_URL);
  for (const c of CACHEABLE) {
    const res = get(c.path, c.name);
    check(res, { [`${c.name}: status 200`]: (r) => r.status === 200 });
    if (!res.headers["Cf-Cache-Status"]) noCfHeader.add(1);
    trackEdgeCache(res);
  }
  sleep(1 + Math.random());
}
