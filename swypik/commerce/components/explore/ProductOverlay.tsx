"use client";

import { useState } from "react";
import { ShoppingCart } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { haptic } from "@/lib/haptic";
import { trackEvent } from "@/lib/feed/track";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import type { FeedVideoProduct } from "@/lib/feed/types";

type Props = { videoId: string; product: FeedVideoProduct; onOpen: () => void };

/** Chip-ul produsului atașat clipului: deschide fișa (drawer) + adăugare rapidă în coș. */
export default function ProductOverlay({ videoId, product, onOpen }: Props) {
  const t = useTranslations("explore");
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const price = product.priceCents != null ? formatMoneyCents(product.priceCents, product.currency, locale) : t("veziPret");
  const buyable = !product.vertical;

  const addToCart = async () => {
    if (busy) return;
    haptic("tap");
    setBusy(true);
    try {
      const res = await fetch("/api/cart/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productId: product.id, quantity: 1, videoId }),
      });
      if (!res.ok) throw new Error("cart_failed");
      trackEvent("add_to_cart", { video_id: videoId, metadata: { product_id: product.id, surface: "feed_product_chip" } });
      toast({ title: t("adaugatInCos"), tone: "success" });
    } catch {
      toast({ title: t("cosulNuSAActualizat"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-full items-center gap-2">
      <button
        type="button"
        onClick={() => {
          haptic("tap");
          onOpen();
        }}
        className="flex min-h-11 min-w-0 items-center gap-2 rounded-card bg-black/45 py-1.5 pl-1.5 pr-3 text-left text-white ring-1 ring-white/15 backdrop-blur-md"
        aria-label={t("openProduct", { name: product.name || t("genericProduct") })}
      >
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- imagini de la selleri/furnizori externi, în afara domeniilor next/image
          <img src={product.image} alt="" className="h-9 w-9 shrink-0 rounded-control object-cover" />
        ) : null}
        <span className="min-w-0 truncate text-sm font-medium">{product.name || t("genericProduct")}</span>
        <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-xs font-bold tabular-nums">{price}</span>
      </button>
      {buyable ? (
        <button
          type="button"
          onClick={addToCart}
          disabled={busy}
          aria-label={t("addToCart")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg shadow-elev-2 disabled:opacity-60"
        >
          <ShoppingCart aria-hidden className="h-5 w-5" />
        </button>
      ) : null}
    </div>
  );
}
