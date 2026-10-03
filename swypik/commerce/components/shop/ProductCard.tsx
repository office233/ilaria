"use client";

import Image from "next/image";
import { Package, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/Badge";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { Currency } from "@/lib/i18n/config";
import type { CatalogCard } from "@/lib/shop/catalog";
import { cn } from "@/lib/ui/cn";
import { Stars } from "./Stars";

type Props = { product: CatalogCard; className?: string; sizes?: string };

/** Card de produs pentru grile și carusele (catalog, categorii, similare, salvate). */
export function ProductCard({ product, className, sizes = "(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 48vw" }: Props) {
  const t = useTranslations("shopBuyer");
  const formatPrice = useFormatPrice();
  const currency = product.currency as Currency;
  const discount =
    product.compareAtCents && product.compareAtCents > product.priceCents
      ? Math.round(((product.compareAtCents - product.priceCents) / product.compareAtCents) * 100)
      : 0;

  return (
    <Link
      href={`/product/${product.id}`}
      className={cn(
        "group block overflow-hidden rounded-card border border-subtle bg-surface shadow-elev-1 transition-shadow duration-fast hover:shadow-elev-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        className,
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-surface-2">
        {product.image ? (
          <Image src={product.image} alt={product.title} fill sizes={sizes} className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-subtle">
            <Package className="h-10 w-10" aria-hidden />
          </div>
        )}
        {discount > 0 ? (
          <Badge tone="danger" className="absolute left-2 top-2">
            {t("common.discountBadge", { percent: discount })}
          </Badge>
        ) : null}
        {product.hasVideo ? (
          <Badge tone="overlay" className="absolute right-2 top-2">
            <Play className="h-3 w-3" aria-hidden />
            {t("common.videoBadge")}
          </Badge>
        ) : null}
      </div>
      <div className="space-y-1 p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm text-fg">{product.title}</p>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-base font-semibold text-fg">{formatPrice(product.priceCents, { sourceCurrency: currency })}</span>
          {discount > 0 && product.compareAtCents ? (
            <span className="text-xs text-subtle line-through">
              {formatPrice(product.compareAtCents, { sourceCurrency: currency })}
            </span>
          ) : null}
        </div>
        {product.rating != null && product.ratingCount > 0 ? (
          <div className="flex items-center gap-1 text-xs text-muted">
            <Stars value={product.rating} size="sm" label={t("reviews.starsAria", { value: product.rating })} />
            <span>({product.ratingCount})</span>
          </div>
        ) : null}
      </div>
    </Link>
  );
}
