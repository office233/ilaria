"use client";

import { ArrowRight, ShoppingCart } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Link } from "@/lib/i18n/navigation";

type Props = {
  priceLabel: string;
  compareLabel?: string | null;
  stockHint?: string | null;
  /** 'product' → adaugă în coș; 'listing' → CTA spre pagina verticalei. */
  mode: "product" | "listing";
  listingHref?: string | null;
  canBuy: boolean;
  busy: boolean;
  justAdded: boolean;
  onAdd: () => void;
};

/**
 * Bara fixă de cumpărare: stă deasupra BottomNav (`bottom: var(--bottom-inset)`),
 * cu safe-area inclusă. Pagina rezervă spațiu cu `pb-28` pe conținut.
 */
export function StickyBuyBar({ priceLabel, compareLabel, stockHint, mode, listingHref, canBuy, busy, justAdded, onAdd }: Props) {
  const t = useTranslations("shopBuyer");
  return (
    <div
      className="fixed inset-x-0 z-header border-t border-subtle bg-surface/95 px-gutter py-3 shadow-elev-3 backdrop-blur-xl"
      style={{ bottom: "var(--bottom-inset)" }}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-lg font-semibold tabular-nums text-fg">{priceLabel}</span>
            {compareLabel ? <span className="text-xs text-subtle line-through">{compareLabel}</span> : null}
          </div>
          {stockHint ? <p className="truncate text-xs text-muted">{stockHint}</p> : null}
        </div>
        {mode === "listing" ? (
          listingHref ? (
            <Button asChild size="lg">
              <Link href={listingHref}>
                {t("product.listingCta")}
                <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            </Button>
          ) : null
        ) : justAdded ? (
          <Button asChild size="lg" variant="soft">
            <Link href="/cart">
              <ShoppingCart aria-hidden className="h-4 w-4" />
              {t("common.viewCart")}
            </Link>
          </Button>
        ) : (
          <Button size="lg" onClick={onAdd} loading={busy} disabled={!canBuy}>
            <ShoppingCart aria-hidden className="h-4 w-4" />
            {canBuy ? t("common.addToCart") : t("common.outOfStock")}
          </Button>
        )}
      </div>
    </div>
  );
}
