"use client";

/**
 * Starea live a unei curse: GET /api/rides/[id] + SSE (/api/rides/[id]/stream,
 * canalul Redis al jobului de dispatch) + polling permanent ca plasă de siguranță.
 * Folosit și de ecranul pasagerului, și de panoul șoferului.
 *
 * Audit food-go #1: la cursele cu cardul stream-ul se deschidea înainte de
 * crearea jobului de dispatch (fără canal), iar polling-ul pornea doar la
 * eroarea SSE → pasagerul rămânea pe „caut șofer". Acum:
 *  - polling-ul rulează mereu cât cursa nu e finală (mai rar cu SSE activ);
 *  - stream-ul se redeschide la `resubscribe` (serverul a văzut jobul) și la
 *    ieșirea cursei din 'requested' (jobul există de acum).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLng } from "./RideMap";
import type { RideResponse } from "./types";

const POLL_MS = Number(process.env.NEXT_PUBLIC_GO_POLL_MS) > 0 ? Number(process.env.NEXT_PUBLIC_GO_POLL_MS) : 10_000;
/** Cu SSE activ: polling mai rar (doar plasă de siguranță). */
const POLL_MS_WITH_SSE = POLL_MS * 3;
const FINAL = new Set(["completed", "cancelled"]);
const ACTIVE = new Set(["accepted", "arriving", "in_progress"]);

export function useRideLive(rideId: string | null) {
  const [data, setData] = useState<RideResponse | null>(null);
  const [driverPos, setDriverPos] = useState<LatLng | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sseDown, setSseDown] = useState(false);
  /** Crește → stream-ul se redeschide (noul canal al jobului). */
  const [streamGen, setStreamGen] = useState(0);
  const statusRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!rideId) return;
    try {
      const res = await fetch(`/api/rides/${rideId}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as RideResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "generic");
        return;
      }
      setError(null);
      setData(body);
      const prev = statusRef.current;
      statusRef.current = body.ride.status;
      // Cursa a plecat la dispatch după ce stream-ul s-a deschis → re-abonare.
      if (prev === "requested" && body.ride.status !== "requested") setStreamGen((g) => g + 1);
      if (ACTIVE.has(body.ride.status) && body.driver?.current_lat != null && body.driver.current_lng != null) {
        setDriverPos({ lat: Number(body.driver.current_lat), lng: Number(body.driver.current_lng) });
      } else if (!ACTIVE.has(body.ride.status)) {
        setDriverPos(null);
      }
    } catch {
      setError("network");
    }
  }, [rideId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!rideId || typeof EventSource === "undefined") {
      setSseDown(true);
      return;
    }
    if (statusRef.current && FINAL.has(statusRef.current)) return;
    const es = new EventSource(`/api/rides/${rideId}/stream`);
    es.onopen = () => setSseDown(false);
    es.onerror = () => setSseDown(true);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; lat?: number; lng?: number };
        if (msg.type === "location" && msg.lat != null && msg.lng != null) {
          if (!statusRef.current || ACTIVE.has(statusRef.current)) setDriverPos({ lat: msg.lat, lng: msg.lng });
        } else if (msg.type === "resubscribe") {
          void refresh();
          setStreamGen((g) => g + 1);
        } else if (msg.type !== "snapshot") {
          void refresh();
        }
      } catch {
        /* mesaj non-JSON (ping) */
      }
    };
    return () => es.close();
  }, [rideId, refresh, streamGen]);

  // Polling permanent cât cursa nu e finală (SSE-ul poate tăcea fără eroare).
  useEffect(() => {
    if (!rideId) return;
    const iv = setInterval(
      () => {
        if (!statusRef.current || !FINAL.has(statusRef.current)) void refresh();
      },
      sseDown ? POLL_MS : POLL_MS_WITH_SSE,
    );
    return () => clearInterval(iv);
  }, [rideId, sseDown, refresh]);

  return { data, driverPos, error, refresh };
}
