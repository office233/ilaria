/**
 * Derularea feed-ului: urmează `paging.nextOffset` pentru până la FEED_PAGES
 * pagini (implicit 5), ca un utilizator care dă swipe prin clipuri.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=load -e FEED_PAGES=8 tests/load/k6/feed-pagination.js
 */
import { sleep } from "k6";
import { Trend } from "k6/metrics";
import { buildOptions } from "./lib/config.js";
import { get, json, checkJson } from "./lib/http.js";

const PAGES = Math.max(1, Number(__ENV.FEED_PAGES) || 5);
const LIMIT = Math.min(50, Math.max(1, Number(__ENV.FEED_LIMIT) || 10));
/** Câte pagini a reușit să parcurgă o iterație (feed prea scurt → valori mici). */
const pagesReached = new Trend("feed_pages_reached");

export const options = buildOptions({
  feed_first_page: { p95: 800, p99: 1500 },
  feed_next_page: { p95: 1000, p99: 2000 },
});

export default function iteration() {
  // Seed per iterație: ordonare diferită, deci fără cache edge — măsoară originea.
  const seed = Math.floor(Math.random() * 1000000);
  let offset = 0;
  let reached = 0;
  for (let page = 0; page < PAGES; page += 1) {
    const name = page === 0 ? "feed_first_page" : "feed_next_page";
    const res = get(`/api/v1/feed?limit=${LIMIT}&offset=${offset}&seed=${seed}`, name);
    const ok = checkJson(res, name, (b) => Array.isArray(b.items) && b.paging && "nextOffset" in b.paging);
    if (!ok || res.status !== 200) break;
    reached += 1;
    const body = json(res);
    const next = body && body.paging ? body.paging.nextOffset : null;
    if (next === null || next === undefined || Number(next) <= offset) break;
    offset = Number(next);
    sleep(0.5 + Math.random() * 1.5); // timp de vizionare între pagini
  }
  pagesReached.add(reached);
  sleep(1);
}
