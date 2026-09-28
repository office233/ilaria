"use client";

import Image from "next/image";
import { ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";
import { OrderPrice } from "@/components/shop/OrderPrice";
import { Button } from "@/components/ui/Button";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { DEFAULT_CURRENCY } from "@/lib/i18n/config";
import { Link } from "@/lib/i18n/navigation";
import type { LiveShopItem } from "@/lib/live/queries";

/**
 * Prețul normal. Prețul „flash” NU se afișează până când checkout-ul nu îl
 * aplică (audit live §2.9) — altfel am promite un preț pe care nu-l încasăm.
 */
function Price({ item }: { item: LiveShopItem }) {
  if (item.price_cents == null) return null;
  return <OrderPrice cents={item.price_cents} currency={item.currency || DEFAULT_CURRENCY} />;
}

/** Cardul produsului fixat de gazdă, deasupra chatului. */
export function PinnedProduct({ item }: { item: LiveShopItem }) {
  const t = useTranslations("live.products");
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-card bg-surface/95 p-2.5 text-fg shadow-elev-2 backdrop-blur">
      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-control bg-surface-2">
        {item.image_url ? <Image src={item.image_url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{item.title}</p>
        <p className="text-sm">
          <Price item={item} />
        </p>
      </div>
      <Button asChild size="sm">
        <Link href={`/product/${item.product_id}`}>{t("buy")}</Link>
      </Button>
    </div>
  );
}

/** Toate produsele prezentate în live, într-un bottom sheet. */
export function ProductsSheet({ items, open, onOpenChange }: { items: LiveShopItem[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("live.products");
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("title", { count: items.length })}>
      <ul className="space-y-0.5 pb-2">
        {items.map((it) => (
          <li key={it.id}>
            <ListItem
              href={`/product/${it.product_id}`}
              leading={
                <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-control bg-surface-2">
                  {it.image_url ? <Image src={it.image_url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : <ShoppingBag className="m-3.5 h-5 w-5 text-subtle" aria-hidden />}
                </span>
              }
              title={it.title ?? t("untitled")}
              subtitle={<Price item={it} />}
            />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
