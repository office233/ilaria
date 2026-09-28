"use client";

import { useEffect } from "react";
import { trackEventImmediate } from "@/lib/feed/track";

export default function PurchaseTracker({ orderId }: { orderId: string }) {
  useEffect(() => {
    if (!orderId) return;
    const key = "swypik_purchase_fired_" + orderId;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {}
    void trackEventImmediate("purchase", { metadata: { order_id: orderId, source: "checkout-success" } });
    // Clear server-side cart (new) + legacy localStorage cart.
    fetch("/api/cart", { method: "DELETE", credentials: "include" }).catch(() => null);
    try {
      window.localStorage.removeItem("aicv_cart");
    } catch {}
  }, [orderId]);
  return null;
}
