"use client";

/** Card de restaurant partener (comandabil) în lista /food. */
import Image from "next/image";
import Link from "next/link";
import { Clock, MapPin, Truck, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { MerchantSummary } from "@/lib/food/types";
import { CUISINE_ICONS, useCuisineLabel } from "./cuisine-ui";

export function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

export default function MerchantCard({ m }: { m: MerchantSummary }) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const cuisineLabel = useCuisineLabel();
  const cuisines = m.cuisines.map(cuisineLabel).filter(Boolean).join(" · ");
  const closed = m.hours_known && m.is_open === false;
  // Fără poză reală → placeholder generic: iconița bucătăriei (nu o poză stoc).
  const Placeholder = CUISINE_ICONS[m.cuisines[0] ?? ""] ?? UtensilsCrossed;

  return (
    <Link
      href={`/food/${m.slug}`}
      className="flex gap-3 rounded-card border border-subtle bg-surface p-3 transition active:scale-[0.99]"
    >
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-control bg-surface-2">
        {m.image_url ? (
          <Image src={m.image_url} alt="" fill sizes="96px" className="object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-subtle">
            <Placeholder size={28} aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-base font-bold text-fg">{m.name}</h3>
          {m.hours_known ? (
            <Badge tone={closed ? "danger" : "success"} size="sm">{closed ? t("closed") : t("open")}</Badge>
          ) : null}
        </div>
        {cuisines ? <p className="mt-0.5 truncate text-sm text-muted">{cuisines}</p> : null}
        {!m.has_menu ? <p className="mt-1 text-sm text-muted">{t("menuSoon")}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-muted">
          {m.eta_min != null && m.eta_max != null ? (
            <span className="inline-flex items-center gap-1">
              <Clock size={12} aria-hidden />
              {t("etaRange", { min: m.eta_min, max: m.eta_max })}
            </span>
          ) : null}
          {m.delivery_fee_cents != null ? (
            <span className="inline-flex items-center gap-1">
              <Truck size={12} aria-hidden />
              {m.delivery_fee_cents === 0 ? t("freeDelivery") : fmt(m.delivery_fee_cents, { showDecimals: false })}
            </span>
          ) : null}
          {m.min_order_cents ? <span>{t("minOrder", { amount: fmt(m.min_order_cents, { showDecimals: false }) })}</span> : null}
          {m.distance_km != null ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} aria-hidden />
              {formatDistance(m.distance_km)}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
