/**
 * Helperi HTTP comuni: cereri etichetate (`name` → praguri de latență per
 * endpoint), check-uri standard, metrici custom pentru 429 și cache-ul edge.
 */
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";
import { BASE_URL, TOLERATE_429, SESSION_COOKIE, SESSION_COOKIE_NAME } from "./config.js";

/** Cereri respinse de rate limiter (429) din totalul cererilor. */
export const rateLimited = new Rate("rate_limited");
/** Răspunsuri servite din cache-ul Cloudflare (`cf-cache-status: HIT`) după încălzire. */
export const edgeCacheHit = new Rate("edge_cache_hit");

if (TOLERATE_429) {
  // 429 devine „așteptat”: nu intră în http_req_failed, rămâne vizibil în `rate_limited`.
  http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));
}

export function url(path) {
  return BASE_URL + path;
}

/** Parametri de cerere; `auth: true` atașează cookie-ul de sesiune al contului de test. */
export function params(name, opts) {
  const o = opts || {};
  const headers = Object.assign({ Accept: "application/json" }, o.headers || {});
  if (o.auth && SESSION_COOKIE) headers.Cookie = `${SESSION_COOKIE_NAME}=${SESSION_COOKIE}`;
  const p = { headers, tags: { name } };
  if (o.timeout) p.timeout = o.timeout;
  if (o.responseType) p.responseType = o.responseType;
  return p;
}

function track(res) {
  rateLimited.add(res.status === 429);
  return res;
}

export function get(path, name, opts) {
  return track(http.get(url(path), params(name, opts)));
}

export function send(method, path, body, name, opts) {
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
  const payload = body === undefined || body === null ? null : JSON.stringify(body);
  return track(http.request(method, url(path), payload, params(name, o)));
}

/** JSON parsat sau null (fără să arunce pe corpuri invalide / goale). */
export function json(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

/**
 * Check standard pentru un răspuns JSON: status 2xx și predicatul pe corp.
 * Cu TOLERATE_429, un 429 trece check-ul (e deja numărat în `rate_limited`).
 */
export function checkJson(res, label, predicate) {
  if (TOLERATE_429 && res.status === 429) return true;
  const body = json(res);
  const checks = {};
  checks[`${label}: status 2xx`] = () => res.status >= 200 && res.status < 300;
  checks[`${label}: corp valid`] = () => body !== null && (!predicate || Boolean(predicate(body)));
  return check(res, checks);
}

/**
 * Înregistrează `cf-cache-status` pentru endpoint-uri cache-abile la edge.
 * Fără header (țintă direct la origine) nu adaugă nimic: metrica e relevantă
 * doar în spatele Cloudflare, cu reguli de cache pentru /api/*.
 */
export function trackEdgeCache(res) {
  const status = res.headers["Cf-Cache-Status"] || res.headers["cf-cache-status"];
  if (!status) return;
  edgeCacheHit.add(String(status).toUpperCase() === "HIT");
}

/** Încălzește cache-ul edge: fiecare cale e cerută de `times` ori (în setup). */
export function warmEdge(paths, times) {
  for (let i = 0; i < (times || 2); i += 1) {
    for (const p of paths) http.get(url(p), params("warmup"));
  }
}
