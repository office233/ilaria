"use client";

/**
 * Heartbeat-ul șoferului: POST /api/couriers/status la HEARTBEAT_MS cu GPS-ul
 * curent (reîmprospătează last_heartbeat_at — sweep-ul din dispatch-tick pune
 * offline șoferii tăcuți). Răspunsul aduce ofertele pending.
 * Starea „online" vine DOAR din răspunsul serverului (fix: după un 403 UI-ul
 * rămânea ONLINE).
 *
 * În aplicația nativă (Capacitor + background-geolocation) poziția vine din
 * plugin și cu aplicația în fundal; fiecare fix trimite și heartbeat-ul
 * (throttled la HEARTBEAT_MS). Serverul păstrează online șoferii cu job în
 * curs o grație extinsă (DISPATCH_ACTIVE_JOB_STALE_SECONDS) — audit #10.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { startNativeLocation } from "./native-location";

const HEARTBEAT_MS =
  Number(process.env.NEXT_PUBLIC_DRIVER_HEARTBEAT_MS) > 0 ? Number(process.env.NEXT_PUBLIC_DRIVER_HEARTBEAT_MS) : 10_000;

export type DriverOffer = {
  offer_id: string;
  kind?: "delivery" | "ride";
  order_id: string | null;
  ride_id: string | null;
  expires_at: string;
  order_number: string | null;
  merchant_name: string;
  pickup_address: string | null;
  delivery_address: string;
  delivery_fee_cents: number;
  currency: string;
};

export type HeartbeatError = "unauthorized" | "not_approved" | "suspended" | "location" | null;

export function useDriverHeartbeat(nativeTexts?: { title: string; message: string }) {
  const [online, setOnline] = useState(false);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [error, setError] = useState<HeartbeatError>(null);
  const [busy, setBusy] = useState(false);
  const coords = useRef<{ lat: number; lng: number; speed_kmh?: number; heading?: number } | null>(null);
  const lastBeat = useRef(0);
  const [nativeActive, setNativeActive] = useState(false);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!online || nativeActive || typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        coords.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setPosition(coords.current);
      },
      () => setError("location"),
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [online, nativeActive]);

  const beat = useCallback(async (wantOnline: boolean): Promise<boolean> => {
    try {
      const res = await fetch("/api/couriers/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          online: wantOnline,
          lat: coords.current?.lat,
          lng: coords.current?.lng,
          speed_kmh: coords.current?.speed_kmh,
          heading: coords.current?.heading,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { online?: boolean; offers?: DriverOffer[]; error?: string };
      if (res.status === 401) setError("unauthorized");
      else if (res.status === 403) setError(body.error === "courier_suspended" ? "suspended" : "not_approved");
      lastBeat.current = Date.now();
      if (!res.ok) {
        setOnline(false);
        setOffers([]);
        return false;
      }
      setError((e) => (e === "location" ? e : null));
      setOnline(Boolean(body.online));
      setOffers(body.online ? body.offers ?? [] : []);
      return true;
    } catch {
      return false; // rețea — reîncercăm la următorul tick
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    const iv = setInterval(() => void beat(true), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [online, beat]);

  // Localizare nativă în fundal (doar în aplicația Capacitor cu pluginul instalat).
  const titleText = nativeTexts?.title ?? "";
  const messageText = nativeTexts?.message ?? "";
  useEffect(() => {
    if (!online || !titleText) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startNativeLocation(
      { title: titleText, message: messageText },
      (fix) => {
        coords.current = fix;
        setPosition({ lat: fix.lat, lng: fix.lng });
        if (Date.now() - lastBeat.current >= HEARTBEAT_MS) void beat(true);
      },
      () => setError("location"),
    ).then((fn) => {
      if (cancelled) fn?.();
      else {
        stop = fn;
        setNativeActive(Boolean(fn));
      }
    });
    return () => {
      cancelled = true;
      stop?.();
      setNativeActive(false);
    };
  }, [online, titleText, messageText, beat]);

  const toggle = useCallback(async () => {
    setBusy(true);
    await beat(!online);
    setBusy(false);
  }, [beat, online]);

  const dropOffer = useCallback((offerId: string) => setOffers((o) => o.filter((x) => x.offer_id !== offerId)), []);

  return { online, offers, error, busy, toggle, dropOffer, position, refresh: () => beat(online) };
}
