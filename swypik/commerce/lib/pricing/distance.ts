/**
 * Distance provider — abstract, cu două implementări:
 *  1. Google Directions API (dacă GOOGLE_MAPS_API_KEY e setat) — distanță și
 *     durată reale pe drum.
 *  2. FALLBACK haversine × 1.3 (factor de corecție drum vs. linie dreaptă)
 *     dacă API-ul lipsește sau eșuează. Durata estimată la viteză medie urbană.
 *
 * Cache Redis 5 min pe cheia (pickup, dropoff) rotunjită la 4 zecimale
 * (~11 m precizie) ca să nu ardem cota Google la re-estimări repetate.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export type LatLng = { lat: number; lng: number };

export type DistanceResult = {
  distance_km: number;
  duration_min: number;
  /** 'google' sau 'haversine' — trasabilitate în breakdown */
  provider: "google" | "haversine";
};

const CACHE_TTL_S = 300; // 5 min
const ROAD_FACTOR = 1.3; // haversine → distanță estimată pe drum
const URBAN_SPEED_KMH = 25; // viteză medie urbană pt. durata fallback

const log = logger.child({ service: "pricing-distance" });

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function round4(n: number): string {
  return n.toFixed(4);
}

function cacheKey(pickup: LatLng, dropoff: LatLng): string {
  return `pricing:dist:${round4(pickup.lat)},${round4(pickup.lng)}:${round4(dropoff.lat)},${round4(dropoff.lng)}`;
}

/** Fallback pur-matematic — nu are nevoie de rețea. */
export function estimateFallback(pickup: LatLng, dropoff: LatLng): DistanceResult {
  const straight = haversineKm(pickup, dropoff);
  const distance_km = Math.round(straight * ROAD_FACTOR * 1000) / 1000;
  const duration_min = Math.max(1, Math.round((distance_km / URBAN_SPEED_KMH) * 60));
  return { distance_km, duration_min, provider: "haversine" };
}

async function fetchGoogleDirections(
  pickup: LatLng,
  dropoff: LatLng,
  apiKey: string,
): Promise<DistanceResult | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${pickup.lat},${pickup.lng}`);
  url.searchParams.set("destination", `${dropoff.lat},${dropoff.lng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    status?: string;
    routes?: Array<{ legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }> }>;
  };
  const leg = json.status === "OK" ? json.routes?.[0]?.legs?.[0] : undefined;
  const meters = leg?.distance?.value;
  const seconds = leg?.duration?.value;
  if (typeof meters !== "number" || typeof seconds !== "number") return null;
  return {
    distance_km: Math.round((meters / 1000) * 1000) / 1000,
    duration_min: Math.max(1, Math.round(seconds / 60)),
    provider: "google",
  };
}

/**
 * Distanța + durata între două puncte, cu cache Redis 5 min.
 * Nu aruncă niciodată: orice eroare (Google/Redis) → fallback haversine.
 */
export async function getDistance(pickup: LatLng, dropoff: LatLng): Promise<DistanceResult> {
  const key = cacheKey(pickup, dropoff);

  // 1. cache
  try {
    const cached = await getRedis().get(key);
    if (cached) return JSON.parse(cached) as DistanceResult;
  } catch (err) {
    log.warn({ err }, "redis get failed — continuing without cache");
  }

  // 2. Google (dacă e configurat), altfel fallback
  let result: DistanceResult | null = null;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (apiKey) {
    try {
      result = await fetchGoogleDirections(pickup, dropoff, apiKey);
    } catch (err) {
      log.warn({ err }, "google directions failed — falling back to haversine");
    }
  }
  if (!result) result = estimateFallback(pickup, dropoff);

  // 3. scrie în cache (best-effort)
  try {
    await getRedis().set(key, JSON.stringify(result), "EX", CACHE_TTL_S);
  } catch {
    /* cache write e best-effort */
  }

  return result;
}
