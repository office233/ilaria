"use client";

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { Currency } from "@/lib/i18n/config";

type Props = {
  subtotalCents: number;
  /** null = încă necalculată (se află la plată). */
  shippingCents: number | null;
  currency: string;
  className?: string;
};

/** Sumarul sumelor (coș + checkout). Totalul afișat = subtotal + livrare cunoscută. */
export function OrderSummary({ subtotalCents, shippingCents, currency, className }: Props) {
  const t = useTranslations("shopBuyer.summary");
  const formatPrice = useFormatPrice();
  const src = currency as Currency;
  const total = subtotalCents + (shippingCents ?? 0);
  return (
    <Card padding="md" className={className}>
      <h2 className="mb-3 text-base font-semibold text-fg">{t("title")}</h2>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">{t("subtotal")}</dt>
          <dd className="tabular-nums text-fg">{formatPrice(subtotalCents, { sourceCurrency: src })}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">{t("shipping")}</dt>
          <dd className="tabular-nums text-fg">
            {shippingCents == null
              ? t("shippingAtCheckout")
              : shippingCents === 0
                ? t("shippingFree")
                : formatPrice(shippingCents, { sourceCurrency: src })}
          </dd>
        </div>
        <div className="flex justify-between border-t border-subtle pt-3 text-base font-semibold">
          <dt className="text-fg">{t("total")}</dt>
          <dd className="tabular-nums text-fg">{formatPrice(total, { sourceCurrency: src })}</dd>
        </div>
      </dl>
    </Card>
  );
}
