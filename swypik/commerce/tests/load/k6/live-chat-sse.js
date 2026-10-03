/**
 * Conexiuni SSE la chatul live: GET /api/live/streams/<id>/chat cu
 * `Accept: text/event-stream` (hub Redis pub/sub + catch-up din DB).
 *
 * k6 nu are EventSource nativ și nu poate citi un corp HTTP în streaming: o
 * cerere SSE sănătoasă NU se termină, deci expiră după SSE_HOLD (implicit 5s)
 * cu error_code 1050 — asta înseamnă „conexiunea a fost acceptată și ținută
 * deschisă”. Un răspuns imediat (400/404/429/5xx) sau altă eroare de rețea e
 * eșec. Dacă serverul închide singur stream-ul (ex. `event: reconnect` la
 * shutdown), verificăm `Content-Type: text/event-stream` și primul cadru
 * (`retry:`). Pentru fan-out real cu mesaje: extensia xk6-sse (vezi docs).
 *
 * Plus: lista JSON recentă (fără Accept SSE) — aceeași rută, ramura non-stream.
 * Streamuri: -e STREAM_IDS=<uuid,...> sau cele live din /api/live/streams.
 *   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke tests/load/k6/live-chat-sse.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";
import { buildOptions, TOLERATE_429 } from "./lib/config.js";
import { get, url, params, checkJson, rateLimited } from "./lib/http.js";
import { discoverLiveStreamIds, pick } from "./lib/discover.js";

const HOLD = __ENV.SSE_HOLD || "5s";
const K6_REQUEST_TIMEOUT = 1050;

/** Conexiuni SSE acceptate (ținute deschise sau închise curat cu event-stream). */
const sseConnectOk = new Rate("sse_connect_ok");
/** Conexiuni refuzate imediat de server (status HTTP ≠ 200). */
const sseRejected = new Counter("sse_rejected");

// Timeout-ul intenționat al SSE ar strica `http_req_failed` global, deci pragul
// de erori se aplică doar cererilor JSON, iar SSE are propriul prag.
export const options = buildOptions(
  { live_chat_recent: { p95: 500, p99: 1000 } },
  {
    "http_req_failed{name:live_chat_recent}": ["rate<0.01"],
    sse_connect_ok: ["rate>0.99"],
  },
);
delete options.thresholds.http_req_failed;

export function setup() {
  const ids = discoverLiveStreamIds(10);
  if (!ids.length) throw new Error("Niciun stream live: setează -e STREAM_IDS=<uuid,...> (un stream live pe staging).");
  return { ids };
}

function openSse(streamId) {
  const p = params("sse_connect", { headers: { Accept: "text/event-stream" }, timeout: HOLD });
  const res = http.get(url(`/api/live/streams/${streamId}/chat`), p);
  rateLimited.add(res.status === 429);

  const heldOpen = res.status === 0 && res.error_code === K6_REQUEST_TIMEOUT;
  const closedCleanly =
    res.status === 200 &&
    String(res.headers["Content-Type"] || "").indexOf("text/event-stream") !== -1 &&
    String(res.body || "").indexOf("retry:") === 0;
  const tolerated429 = TOLERATE_429 && res.status === 429;
  if (res.status >= 400 && !tolerated429) sseRejected.add(1);

  const ok = heldOpen || closedCleanly || tolerated429;
  sseConnectOk.add(ok);
  check(res, { "sse: conexiune acceptată (ținută deschisă sau event-stream valid)": () => ok });
}

export default function iteration(data) {
  const streamId = pick(data.ids);
  const recent = get(`/api/live/streams/${streamId}/chat?limit=50`, "live_chat_recent");
  checkJson(recent, "live_chat_recent", (b) => Array.isArray(b.items));
  openSse(streamId);
  sleep(1 + Math.random());
}
