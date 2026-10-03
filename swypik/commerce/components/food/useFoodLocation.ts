"use client";

/**
 * Orașul ales / poziția GPS pentru /food (persistate local; GPS expiră după GEO_TTL_MS).
 * Erorile se întorc ca și coduri — pagina le afișează prin toast, nu alert().
 */
import { useCallback, useEffect, useState } from "react";

const CITY_KEY = "swypik_city";
const GEO_KEY = "swypik_geo";
const GEO_TTL_MS = 30 * 60 * 1000;

export type GeoPoint = { lat: number; lng: number };
export type GeoError = "unsupported" | "denied" | "failed";

function readStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function useFoodLocation() {
  const [city, setCityState] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setCityState(localStorage.getItem(CITY_KEY));
    } catch {
      /* stocare indisponibilă */
    }
    const cached = readStorage<GeoPoint & { t?: number }>(GEO_KEY);
    if (cached?.lat != null && Date.now() - (cached.t ?? 0) < GEO_TTL_MS) setGeo({ lat: cached.lat, lng: cached.lng });
    setReady(true);
  }, []);

  const setCity = useCallback((c: string | null) => {
    const v = c?.trim() || null;
    setCityState(v);
    setGeo(null);
    try {
      if (v) localStorage.setItem(CITY_KEY, v);
      else localStorage.removeItem(CITY_KEY);
      localStorage.removeItem(GEO_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const locate = useCallback(
    () =>
      new Promise<GeoError | null>((resolve) => {
        if (!("geolocation" in navigator)) return resolve("unsupported");
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const g = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            try {
              localStorage.setItem(GEO_KEY, JSON.stringify({ ...g, t: Date.now() }));
            } catch {
              /* ignore */
            }
            setGeo(g);
            setLocating(false);
            resolve(null);
          },
          (err) => {
            setLocating(false);
            resolve(err.code === 1 ? "denied" : "failed");
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
        );
      }),
    [],
  );

  const clearGeo = useCallback(() => {
    setGeo(null);
    try {
      localStorage.removeItem(GEO_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { city, geo, locating, ready, setCity, locate, clearGeo };
}
