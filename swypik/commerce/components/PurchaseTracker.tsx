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
    // Settlement closes the originating cart server-side. Revisiting an old
    // order must not delete products in the shopper's new active cart.
    try {
      window.localStorage.removeItem("aicv_cart");
    } catch {}
  }, [orderId]);
  return null;
}
