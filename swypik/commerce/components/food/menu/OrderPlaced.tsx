"use client";

/** Confirmarea după plasare: număr comandă + link de tracking (cu token pentru guest). */
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import type { PlacedOrder } from "./useCheckout";

export function trackingHref(order: { id: string; tracking_token?: string | null }): string {
  return order.tracking_token
    ? `/food/orders/${order.id}?t=${encodeURIComponent(order.tracking_token)}`
    : `/food/orders/${order.id}`;
}

export default function OrderPlaced({ order, merchantName }: { order: PlacedOrder; merchantName: string }) {
  const t = useTranslations("foodHub");
  return (
    <div className="grid min-h-[70dvh] place-items-center bg-canvas px-gutter">
      <div className="w-full max-w-sm text-center">
        <CheckCircle2 size={56} className="mx-auto text-success" aria-hidden />
        <h1 className="mt-4 text-xl font-bold text-fg">{t("orderPlaced")}</h1>
        <p className="mt-2 text-sm text-muted">
          {t("orderNumber")} <span className="font-bold text-fg">{order.order_number}</span>
        </p>
        <p className="mt-1 text-sm text-muted">{t("confirmsSoon", { name: merchantName })}</p>
        {order.tracking_token ? <p className="mt-2 text-xs text-subtle">{t("guestTrackingHint")}</p> : null}
        <div className="mt-6 space-y-3">
          <Button asChild block size="lg">
            <Link href={trackingHref(order)}>{t("trackLive")}</Link>
          </Button>
          <Button asChild block variant="secondary">
            <Link href="/food">{t("backToRestaurants")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
