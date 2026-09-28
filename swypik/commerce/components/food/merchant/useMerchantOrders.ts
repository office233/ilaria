"use client";

/**
 * Comenzile active ale restaurantului: polling + sunet la comandă nouă + acțiuni de status.
 * Sunetul folosește AudioContext-ul partajat deblocat la primul gest (iOS — audit #21);
 * în afara panoului restaurantul primește push (lib/food/merchant-notify).
 * Fără pino în bundle-ul de client (audit #29).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { armAlertAudio, playTones } from "@/components/go/alert-audio";

export type MerchantOrder = {
  id: string;
  order_number: string;
  status: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_notes: string | null;
  items: { name: string; qty: number; unit_price_cents: number; options?: { name: string }[]; notes?: string | null }[];
  total_cents: number;
  payment_method: string;
  payment_status: string;
  payment_authorized_at?: string | null;
  dispatch_status: string | null;
  courier_id: string | null;
  placed_at: string;
};

const POLL_MS = 10_000;
const DING_HZ = 880;

function playDing(): void {
  playTones([{ start: 0, freq: DING_HZ, duration: 0.8, gain: 0.3 }]);
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.([150, 80, 150]);
}

export function useMerchantOrders(merchantId: string | null) {
  const [orders, setOrders] = useState<MerchantOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const known = useRef<Set<string>>(new Set());
  const first = useRef(true);

  const poll = useCallback(async () => {
    if (!merchantId) return;
    try {
      const res = await fetch(`/api/merchants/${merchantId}/orders?status=active&limit=100`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { orders?: MerchantOrder[] };
      const list = data.orders ?? [];
      if (!first.current && list.some((o) => !known.current.has(o.id))) playDing();
      list.forEach((o) => known.current.add(o.id));
      first.current = false;
      setOrders(list);
    } catch {
      /* rețea — reîncercăm la următorul poll */
    } finally {
      setLoaded(true);
    }
  }, [merchantId]);

  useEffect(() => armAlertAudio(), []);

  useEffect(() => {
    if (!merchantId) return;
    first.current = true;
    known.current = new Set();
    setLoaded(false);
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [merchantId, poll]);

  /** PATCH status; întoarce codul de eroare sau null. */
  const setStatus = useCallback(
    async (orderId: string, status: string, reason?: string): Promise<string | null> => {
      const res = await fetch(`/api/local-orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason: reason || undefined }),
      });
      const data = (await res.json().catch(() => null)) as { code?: string } | null;
      void poll();
      return res.ok ? null : data?.code ?? "server_error";
    },
    [poll],
  );

  /** Pornește căutarea de curier prin API-ul existent de dispatch. */
  const findCourier = useCallback(
    async (orderId: string): Promise<boolean> => {
      const res = await fetch(`/api/local-orders/${orderId}/dispatch`, { method: "POST" });
      void poll();
      return res.ok;
    },
    [poll],
  );

  return { orders, loaded, setStatus, findCourier };
}
