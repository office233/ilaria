/**
 * Știri: lista paginată GET /api/news?limit=&offset= (+ uneori pagina a doua).
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/news.js
 */
import { sleep } from "k6";
import { buildOptions } from "./lib/config.js";
import { get, json, checkJson, trackEdgeCache } from "./lib/http.js";

export const options = buildOptions({ news_list: { p95: 600, p99: 1200 } });

export default function iteration() {
  const first = get("/api/news?limit=20&offset=0", "news_list");
  checkJson(first, "news_list", (b) => b.ok === true && Array.isArray(b.articles));
  trackEdgeCache(first);
  const body = json(first);
  if (body && body.hasMore && Math.random() < 0.3) {
    sleep(1);
    const second = get("/api/news?limit=20&offset=20", "news_list");
    checkJson(second, "news_list", (b) => b.ok === true && Array.isArray(b.articles));
  }
  sleep(2 + Math.random() * 3);
}
