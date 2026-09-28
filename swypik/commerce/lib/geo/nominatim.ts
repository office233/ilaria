/**
 * Nominatim (OSM) — search + reverse geocoding, server-side only.
 *
 * Politica Nominatim cere: User-Agent identificabil, max 1 req/s, cache.
 * De aceea TOATE apelurile trec pe aici (proxy /api/geo/*), cu cache Redis
 * 24h pe query normalizat — clientul nu mai lovește nominatim.org direct.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";
import { HELLO_EMAIL } from "@/lib/contact";

const log = logger.child({ mod: "geo-nominatim" });

const BASE = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const USER_AGENT = `Swypik/1.0 (${APP_URL}; ${HELLO_EMAIL})`;
const CACHE_TTL_SECONDS = 24 * 3600;

export type GeoResult = {
  address: string;
  lat: number;
  lng: number;
  city: string | null;
};

type NominatimRow = {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string>;
};

/** Orașul dintr-un obiect address Nominatim (city > town > village > municipality). */
function extractCity(addr: Record<string, string> | undefined): string | null {
  if (!addr) return null;
  return addr.city || addr.town || addr.village || addr.municipality || addr.county || null;
}

async function cachedFetch(cacheKey: string, url: string): Promise<unknown | null> {
  // Cache Redis 24h (best-effort — fără Redis mergem direct la sursă).
  try {
    const redis = getRedis();
    const hit = await redis.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch { /* Redis indisponibil — continuăm */ }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ro,en" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // Fără acest catch, un timeout ajungea la apelant ca un
    // "[Error [TimeoutError]: ...]" fără nicio urmă că sursa era Nominatim.
    log.warn({ err, url }, "nominatim fetch failed or timed out");
    return null;
  }
  if (!res.ok) {
    log.warn({ url, status: res.status }, "nominatim non-200");
    return null;
  }
  const data: unknown = await res.json();
  try {
    const redis = getRedis();
    await redis.set(cacheKey, JSON.stringify(data), "EX", CACHE_TTL_SECONDS);
  } catch { /* best-effort */ }
  return data;
}

/** Căutare adrese (max 5), pentru autocomplete. */
export async function geoSearch(q: string): Promise<GeoResult[]> {
  const query = q.trim().toLowerCase();
  if (query.length < 3) return [];
  const url = `${BASE}/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=ro&q=${encodeURIComponent(query)}`;
  const data = await cachedFetch(`geo:search:${query}`, url);
  if (!Array.isArray(data)) return [];
  return (data as NominatimRow[])
    .filter((r) => r.lat && r.lon)
    .map((r) => ({
      address: r.display_name ?? "",
      lat: Number.parseFloat(r.lat!),
      lng: Number.parseFloat(r.lon!),
      city: extractCity(r.address),
    }));
}

/** Reverse geocoding — folosit pentru a deriva orașul din pickup (server-side). */
export async function geoReverse(lat: number, lng: number): Promise<GeoResult | null> {
  // Rotunjim la ~110m pentru chei de cache stabile.
  const rl = lat.toFixed(3);
  const rg = lng.toFixed(3);
  const url = `${BASE}/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`;
  const data = await cachedFetch(`geo:rev:${rl}:${rg}`, url);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as NominatimRow;
  if (!r.lat || !r.lon) return null;
  return {
    address: r.display_name ?? "",
    lat: Number.parseFloat(r.lat),
    lng: Number.parseFloat(r.lon),
    city: extractCity(r.address),
  };
}

/** Orașul derivat din coordonatele de pickup — sursa de adevăr pentru pricing. */
export async function cityFromCoords(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await geoReverse(lat, lng);
    return r?.city ?? null;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "cityFromCoords failed");
    return null;
  }
}
