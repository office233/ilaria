"use client";

/**
 * Datele de tracking ale unei comenzi Food: GET /api/local-orders/[id]
 * (+ token guest), SSE pe job-ul de dispatch pentru poziția curierului și
 * polling de rezervă cât timp comanda e activă.
 */
import { useCallback, useEffect, useState } from "react";
import { orderTokenKey } from "../menu/useCheckout";

export type TrackedOrder = {
  id: string;
  order_number: string;
  status: string;
  dispatch_status: string | null;
  items: { menu_item_id: string; name: string; qty: number; unit_price_cents: number; options?: { name: string }[] }[];
  subtotal_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  payment_method: string;
  payment_status: string;
  refund_status: string | null;
  delivery_address: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
  estimated_delivery_at: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  can_cancel: boolean;
  merchant: { id: string; name: string; slug: string; phone: string | null; lat: number | null; lng: number | null };
  courier: { id: string; name: string; phone: string | null; vehicle_type: string; lat: number | null; lng: number | null } | null;
  dispatch_job_id: string | null;
};

export const FINAL = ["delivered", "cancelled", "rejected"];
const POLL_MS = 20_000;

function readToken(orderId: string): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("t");
  try {
    if (fromUrl) {
      localStorage.setItem(orderTokenKey(orderId), fromUrl);
      return fromUrl;
    }
    return localStorage.getItem(orderTokenKey(orderId));
  } catch {
    return fromUrl;
  }
}

export function useOrderTracking(orderId: string) {
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [error, setError] = useState<"no_access" | "not_found" | "network" | null>(null);
  const [courierPos, setCourierPos] = useState<{ lat: number; lng: number } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenRead, setTokenRead] = useState(false);

  useEffect(() => {
    setToken(readToken(orderId));
    setTokenRead(true);
  }, [orderId]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/local-orders/${orderId}`, {
        cache: "no-store",
        headers: token ? { "x-order-token": token } : undefined,
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; order?: TrackedOrder } | null;
      if (!res.ok || !data?.order) {
        setError(res.status === 401 ? "no_access" : res.status === 404 ? "not_found" : "network");
        return;
      }
      setError(null);
      setOrder(data.order);
      const c = data.order.courier;
      if (c?.lat != null && c.lng != null) setCourierPos({ lat: c.lat, lng: c.lng });
    } catch {
      setError("network");
    }
  }, [orderId, token]);

  useEffect(() => {
    if (tokenRead) void refresh();
  }, [tokenRead, refresh]);

  const isFinal = order != null && FINAL.includes(order.status);
  const jobId = order?.dispatch_job_id ?? null;

  // SSE (doar utilizatori logați — EventSource nu poate trimite token-ul guest).
  useEffect(() => {
    if (!jobId || isFinal || token) return;
    const es = new EventSource(`/api/dispatch/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; lat?: number; lng?: number };
        if (msg.type === "location" && msg.lat != null && msg.lng != null) setCourierPos({ lat: msg.lat, lng: msg.lng });
        else if (msg.type === "status" || msg.type === "snapshot") void refresh();
      } catch {
        /* mesaj corupt */
      }
    };
    return () => es.close();
  }, [jobId, isFinal, token, refresh]);

  const hasOrder = order != null;
  useEffect(() => {
    if (!hasOrder || isFinal) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [hasOrder, isFinal, refresh]);

  return { order, error, courierPos, token, isFinal, refresh };
}
