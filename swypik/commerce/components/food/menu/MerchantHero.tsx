"use client";

/** Coperta + cardul de informații al restaurantului (nume, bucătărie, ETA, taxă, program). */
import Image from "next/image";
import { Clock, Truck } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { MerchantSummary } from "@/lib/food/types";
import { useCuisineLabel } from "../cuisine-ui";

export default function MerchantHero({ m, deliveryFeeCents }: { m: MerchantSummary; deliveryFeeCents: number | null }) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const cuisineLabel = useCuisineLabel();
  const cuisines = m.cuisines.map(cuisineLabel).filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader back="/food" title={m.name} />
      {m.image_url ? (
        <div className="relative h-40 w-full bg-surface-2">
          <Image src={m.image_url} alt="" fill sizes="100vw" className="object-cover" priority />
        </div>
      ) : null}
      <div className="px-gutter">
        <div className={`relative rounded-card border border-subtle bg-surface p-4 shadow-elev-1 ${m.image_url ? "-mt-6" : "mt-4"}`}>
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-lg font-bold leading-tight text-fg">{m.name}</h2>
            {m.is_orderable ? (
              m.hours_known ? (
                <Badge tone={m.is_open ? "success" : "danger"}>{m.is_open ? t("open") : t("closed")}</Badge>
              ) : (
                <Badge>{t("hoursUnknown")}</Badge>
              )
            ) : (
              <Badge tone="warning">{t("notOnSwypik")}</Badge>
            )}
          </div>
          {cuisines ? <p className="mt-0.5 text-sm text-muted">{cuisines}</p> : null}
          {m.address ? <p className="mt-0.5 text-sm text-muted">{m.address}</p> : null}
          {m.is_orderable ? (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-muted">
              {m.eta_min != null && m.eta_max != null ? (
                <span className="inline-flex items-center gap-1">
                  <Clock size={14} aria-hidden />
                  {t("etaRange", { min: m.eta_min, max: m.eta_max })}
                </span>
              ) : null}
              {deliveryFeeCents != null ? (
                <span className="inline-flex items-center gap-1">
                  <Truck size={14} aria-hidden />
                  {deliveryFeeCents === 0 ? t("freeDelivery") : fmt(deliveryFeeCents)}
                </span>
              ) : null}
              {m.min_order_cents ? <span>{t("minOrder", { amount: fmt(m.min_order_cents) })}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
