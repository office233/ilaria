/**
 * Descoperirea id-urilor reale în setup(): mai întâi din env (PRODUCT_IDS,
 * VIDEO_IDS, STREAM_IDS), altfel din endpoint-urile de listare publice.
 */
import { idsFromEnv } from "./config.js";
import { get, json } from "./http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}

function unique(list) {
  const out = [];
  for (const v of list) if (v && out.indexOf(v) === -1) out.push(v);
  return out;
}

/** Id-uri de produs: PRODUCT_IDS sau primele din GET /api/products. */
export function discoverProductIds(max) {
  const fromEnv = idsFromEnv("PRODUCT_IDS");
  if (fromEnv.length) return fromEnv;
  const body = json(get(`/api/products?limit=${max || 20}`, "discover_products"));
  const products = (body && body.products) || [];
  return unique(products.map((p) => (p && (p.id || p.product_id) ? String(p.id || p.product_id) : null)));
}

/** Id-uri de video (UUID): VIDEO_IDS sau din primele pagini ale feed-ului. */
export function discoverVideoIds(max) {
  const fromEnv = idsFromEnv("VIDEO_IDS");
  if (fromEnv.length) return fromEnv;
  const body = json(get(`/api/v1/feed?limit=${max || 20}&offset=0`, "discover_feed"));
  const items = (body && body.items) || [];
  return unique(items.map((it) => (it && isUuid(it.video_id) ? it.video_id : null)));
}

/** Id-uri de stream live: STREAM_IDS sau streamurile live din GET /api/live/streams. */
export function discoverLiveStreamIds(max) {
  const fromEnv = idsFromEnv("STREAM_IDS");
  if (fromEnv.length) return fromEnv;
  const body = json(get(`/api/live/streams?status=live&limit=${max || 10}`, "discover_live"));
  const items = (body && body.items) || [];
  return unique(items.map((s) => (s && isUuid(s.id) ? s.id : null)));
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
