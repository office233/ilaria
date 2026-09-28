/**
 * Feed-ul de pe Acasă, anonim: GET /api/v1/feed (prima pagină).
 * Fără cookie răspunsul e partajat (`s-maxage=120`) → poate fi HIT la edge.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/home-feed.js
 */
import { sleep } from "k6";
import { buildOptions } from "./lib/config.js";
import { get, checkJson, trackEdgeCache, warmEdge } from "./lib/http.js";

const FEED_PATH = "/api/v1/feed?limit=15&offset=0";

export const options = buildOptions({ feed_first_page: { p95: 800, p99: 1500 } });

export function setup() {
  warmEdge([FEED_PATH], 2);
}

export default function iteration() {
  const res = get(FEED_PATH, "feed_first_page");
  checkJson(res, "feed", (b) => Array.isArray(b.items) && b.paging && typeof b.paging === "object");
  trackEdgeCache(res);
  sleep(1 + Math.random() * 2);
}
