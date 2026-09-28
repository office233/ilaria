"use client";

import Image from "next/image";
import { Package, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { Link } from "@/lib/i18n/navigation";
import type { Currency } from "@/lib/i18n/config";
import type { CartLine } from "@/lib/shop/cart";
import { QuantityStepper } from "../QuantityStepper";

type Props = {
  line: CartLine;
  maxLineQty: number;
  busy: boolean;
  onQuantity: (qty: number) => void;
  onRemove: () => void;
};

/** O linie din coș: imagine, titlu (link la produs), variantă, preț curent, cantitate, eliminare. */
export function CartLineItem({ line, maxLineQty, busy, onQuantity, onRemove }: Props) {
  const t = useTranslations("shopBuyer");
  const formatPrice = useFormatPrice();
  const currency = line.currency as Currency;
  const max = Math.max(1, Math.min(maxLineQty, line.stock ?? maxLineQty));

  return (
    <li className="flex gap-3 py-4">
      <Link href={`/product/${line.productId}`} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-control bg-surface-2">
        {line.image ? (
          <Image src={line.image} alt="" fill sizes="80px" className="object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center text-subtle">
            <Package className="h-6 w-6" aria-hidden />
          </span>
        )}
      </Link>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start gap-2">
          <Link href={`/product/${line.productId}`} className="line-clamp-2 flex-1 text-sm font-medium text-fg hover:underline">
            {line.title}
          </Link>
          <IconButton label={t("cart.removeAria", { title: line.title })} size="sm" onClick={onRemove} disabled={busy} className="-mr-1 -mt-1">
            <Trash2 aria-hidden />
          </IconButton>
        </div>
        {line.variantTitle ? <p className="text-xs text-muted">{line.variantTitle}</p> : null}
        {!line.purchasable ? (
          <Badge tone="danger" size="sm">
            {t("cart.unavailable")}
          </Badge>
        ) : line.stock != null && line.stock < line.quantity ? (
          <Badge tone="warning" size="sm">
            {t("common.lowStock", { count: line.stock })}
          </Badge>
        ) : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          <QuantityStepper value={line.quantity} max={max} onChange={onQuantity} disabled={busy || !line.purchasable} />
          <span className="text-sm font-semibold tabular-nums text-fg">
            {formatPrice(line.priceCents * line.quantity, { sourceCurrency: currency })}
          </span>
        </div>
      </div>
    </li>
  );
}
