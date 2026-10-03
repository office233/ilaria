/**
 * Swypik media Worker — rulează pe domeniul CDN de media (ex. media.swypik.com),
 * cu bucket-ul R2 legat ca `MEDIA_BUCKET`.
 *
 *   GET /s/<token>/<cale>   media privată/plătită: token-ul (emis de aplicație,
 *                           vezi lib/media/signed-media.ts) acoperă un director
 *                           întreg (episod HLS) sau un obiect (piesă audio).
 *   GET /private/...        acces direct la prefixul privat → 403.
 *   GET /<cheie>            (doar dacă Worker-ul primește și rutele publice)
 *                           obiect public din R2, cu cache la edge.
 *
 * Cache: cheia de cache NU conține token-ul (`/__media/<cheie>`), deci toți
 * cumpărătorii unui episod împart aceleași segmente cache-uite la edge.
 * Cererile cu `Range` (mp4/audio) merg direct în R2 (fără Cache API).
 */
import { openToken, resolveSignedKey } from "./token";
import { hasBody, type CacheLike, type ExecutionContextLike, type MediaWorkerEnv, type R2ObjectLike } from "./types";

export const SIGNED_PREFIX = "/s/";
const DEFAULT_PRIVATE_PREFIX = "private/";
const CACHE_KEY_PATH = "/__media/";
const IMMUTABLE = "public, max-age=31536000, immutable";
const PLAYLIST = "public, max-age=60";
const PRIVATE_BROWSER_SEGMENT = "private, max-age=3600";
const PRIVATE_BROWSER_PLAYLIST = "private, max-age=60";
const CORS_MAX_AGE_S = "86400";

function isPlaylist(key: string): boolean {
  return /\.m3u8$/i.test(key);
}

function edgeCacheControl(key: string, object: R2ObjectLike): string {
  return object.httpMetadata?.cacheControl || (isPlaylist(key) ? PLAYLIST : IMMUTABLE);
}

function allowedOrigin(request: Request, env: MediaWorkerEnv): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function withCors(response: Response, request: Request, env: MediaWorkerEnv): Response {
  const origin = allowedOrigin(request, env);
  const headers = new Headers(response.headers);
  headers.append("vary", "Origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
  }
  return new Response(response.body, { status: response.status, headers });
}

function plain(status: number, request: Request, env: MediaWorkerEnv): Response {
  return withCors(new Response(null, { status, headers: { "cache-control": "no-store" } }), request, env);
}

function objectResponse(key: string, object: R2ObjectLike, request: Request): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", edgeCacheControl(key, object));
  if (!hasBody(object)) return new Response(null, { status: 304, headers });
  const range = object.range;
  if (request.headers.has("range") && range && range.offset !== undefined && range.length !== undefined) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set("content-length", String(range.length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

async function serveObject(key: string, request: Request, env: MediaWorkerEnv, cache: CacheLike | null, ctx: ExecutionContextLike): Promise<Response> {
  const cacheable = cache !== null && request.method === "GET" && !request.headers.has("range");
  const cacheKey = new Request(new URL(`${CACHE_KEY_PATH}${key.split("/").map(encodeURIComponent).join("/")}`, request.url).toString());
  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const object = await env.MEDIA_BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const response = objectResponse(key, object, request);
  if (cacheable && response.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/** Răspunsul pentru browser la media semnată: niciodată cache partajat în afara edge-ului. */
function privatize(response: Response, key: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", isPlaylist(key) ? PRIVATE_BROWSER_PLAYLIST : PRIVATE_BROWSER_SEGMENT);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleMediaRequest(request: Request, env: MediaWorkerEnv, ctx: ExecutionContextLike, cache: CacheLike | null): Promise<Response> {
  if (request.method === "OPTIONS") {
    const origin = allowedOrigin(request, env);
    const headers = new Headers({ "access-control-max-age": CORS_MAX_AGE_S, vary: "Origin" });
    if (origin) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
      headers.set("access-control-allow-headers", "Range, If-None-Match, If-Modified-Since");
    }
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, request, env);

  const path = new URL(request.url).pathname;
  const privatePrefix = env.PRIVATE_PREFIX || DEFAULT_PRIVATE_PREFIX;

  if (path.startsWith(SIGNED_PREFIX)) {
    const rest = path.slice(SIGNED_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return plain(403, request, env);
    const payload = await openToken(rest.slice(0, slash), env.MEDIA_SIGNING_SECRET);
    const key = payload ? resolveSignedKey(payload.prefix, rest.slice(slash + 1)) : null;
    if (!key) return plain(403, request, env);
    return withCors(privatize(await serveObject(key, request, env, cache, ctx), key), request, env);
  }

  let key: string;
  try {
    key = decodeURIComponent(path.slice(1));
  } catch {
    return plain(400, request, env);
  }
  if (!key || key.split("/").includes("..")) return plain(404, request, env);
  if (key.startsWith(privatePrefix)) return plain(403, request, env);
  return withCors(await serveObject(key, request, env, cache, ctx), request, env);
}
