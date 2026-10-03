"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { goFetch } from "../format";
import type { Place, Quote } from "../types";

/** Oferta (clase + prețuri + metode de plată) pentru traseul curent. */
export function useQuote(pickup: Place | null, dropoff: Place | null) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!pickup || !dropoff) {
      setQuote(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    const r = await goFetch<Quote>("/api/rides/quote", {
      method: "POST",
      body: JSON.stringify({ pickup, dropoff }),
    });
    if (id !== seq.current) return; // răspuns depășit de o căutare mai nouă
    setLoading(false);
    if (r.ok) setQuote(r.data);
    else {
      setQuote(null);
      setError(r.error);
    }
  }, [pickup, dropoff]);

  useEffect(() => {
    void load();
  }, [load]);

  return { quote, loading, error, reload: load };
}

/** Pickup din GPS + adresă prin reverse geocoding (proxy intern /api/geo/reverse). */
export function useLocatePickup(fallbackLabel: string, onPlace: (p: Place) => void) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mounted.current) return;
        const { latitude: lat, longitude: lng } = pos.coords;
        onPlace({ address: fallbackLabel, lat, lng });
        void fetch(`/api/geo/reverse?lat=${lat}&lng=${lng}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { result?: { address?: string } } | null) => {
            if (mounted.current && d?.result?.address) onPlace({ address: d.result.address, lat, lng });
          })
          .catch(() => undefined);
      },
      () => undefined,
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [fallbackLabel, onPlace]);
}
