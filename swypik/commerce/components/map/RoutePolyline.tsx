"use client";

/**
 * RoutePolyline — traseu pe străzi via OSRM, cu fallback la linie dreaptă.
 *
 * Serverul OSRM vine din NEXT_PUBLIC_OSRM_URL. Nu există un default: serverul
 * demo public router.project-osrm.org interzice explicit folosirea în producție
 * și nu are SLA. Fără variabilă, ruta se desenează în linie dreaptă.
 */
import { useEffect, useState } from "react";
import { Polyline } from "react-leaflet";

type Point = { lat: number; lng: number };

const OSRM_URL = (process.env.NEXT_PUBLIC_OSRM_URL ?? "").replace(/\/$/, "");

const routeCache = new Map<string, [number, number][]>();

export default function RoutePolyline({
  points,
  color = "#10B981",
  casingColor = "#0D0D0D",
}: {
  points: Point[];
  color?: string;
  casingColor?: string;
}) {
  const [routeCoords, setRouteCoords] = useState<[number, number][]>(() =>
    points.map((p) => [p.lat, p.lng] as [number, number]),
  );

  useEffect(() => {
    if (points.length < 2) return;
    const p1 = points[0];
    const p2 = points[points.length - 1];
    const key = `${p1.lat.toFixed(4)},${p1.lng.toFixed(4)}-${p2.lat.toFixed(4)},${p2.lng.toFixed(4)}`;

    if (routeCache.has(key)) {
      setRouteCoords(routeCache.get(key)!);
      return;
    }
    if (!OSRM_URL) {
      setRouteCoords(points.map((p) => [p.lat, p.lng] as [number, number]));
      return;
    }

    let isMounted = true;
    const controller = new AbortController();

    async function fetchRoadRoute() {
      try {
        const url = `${OSRM_URL}/route/v1/driving/${p1.lng},${p1.lat};${p2.lng},${p2.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("OSRM error");
        const data = await res.json();
        const coords = data?.routes?.[0]?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length > 0) {
          // OSRM dă [lng, lat] -> Leaflet vrea [lat, lng]
          const mapped = coords.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
          routeCache.set(key, mapped);
          if (isMounted) setRouteCoords(mapped);
          return;
        }
      } catch {
        // Fallback la punctele directe
      }
      if (isMounted) {
        setRouteCoords(points.map((p) => [p.lat, p.lng] as [number, number]));
      }
    }

    void fetchRoadRoute();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [points]);

  if (routeCoords.length < 2) return null;

  return (
    <>
      {/* 1. Neon ambient glow (estompare luminoasă exterioară) */}
      <Polyline
        positions={routeCoords}
        pathOptions={{
          color,
          weight: 14,
          opacity: 0.22,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
      {/* 2. Casing exterior de adâncime (Road asphalt boundary) */}
      <Polyline
        positions={routeCoords}
        pathOptions={{
          color: casingColor,
          weight: 8,
          opacity: 0.7,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
      {/* 3. Traseu principal de navigare stil Bolt / Uber */}
      <Polyline
        positions={routeCoords}
        pathOptions={{
          color,
          weight: 5,
          opacity: 0.98,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
      {/* 4. Miez luminos interior (Fiber-optic highlight) */}
      <Polyline
        positions={routeCoords}
        pathOptions={{
          color: "#FFFFFF",
          weight: 1.8,
          opacity: 0.8,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
    </>
  );
}
