/**
 * Swypik Music: ecranul principal + tab-ul Radio din feed-ul audio.
 *   GET /api/music/home
 *   GET /api/audio/feed?tab=radio  (s-maxage=120 → cache-abil la edge)
 * Atenție: /api/music/home are limita `musicCatalog` = 60 cereri/min per IP.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/music-home.js
 */
import { sleep } from "k6";
import { buildOptions } from "./lib/config.js";
import { get, checkJson, trackEdgeCache, warmEdge } from "./lib/http.js";

const RADIO_PATH = "/api/audio/feed?tab=radio";

export const options = buildOptions({
  music_home: { p95: 700, p99: 1500 },
  audio_feed_radio: { p95: 1200, p99: 2500 },
});

export function setup() {
  warmEdge([RADIO_PATH], 2);
}

export default function iteration() {
  const home = get("/api/music/home", "music_home");
  checkJson(home, "music_home", (b) => Array.isArray(b.rows));
  sleep(0.5);

  const radio = get(RADIO_PATH, "audio_feed_radio");
  checkJson(radio, "audio_feed_radio", (b) => Array.isArray(b.sections));
  trackEdgeCache(radio);
  sleep(2 + Math.random() * 3);
}
