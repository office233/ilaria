"use client";

import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Truck } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { formatSellerDate, formatSellerMoney, shortOrderId } from "@/components/seller/format";
import { OrderStateBadge } from "./OrderStateBadge";
import type { SellerOrderRow } from "./types";

/** Cardul unei comenzi în listă (mobile-first; pe desktop aceeași grilă, mai lată). */
export function OrderCard({ order, onOpen }: { order: SellerOrderRow; onOpen: () => void }) {
  const t = useTranslations("sellerPanel.orders");
  const locale = useLocale();
  const m = order.order_metadata;
  const itemsLabel = order.items.map((i) => `${i.quantity}× ${i.title}`).join(", ");
  return (
    <Card padding="none" interactive>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 p-4 text-left">
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fg">#{shortOrderId(order.order_id)}</span>
            <OrderStateBadge state={order.state} />
          </span>
          <span className="block truncate text-sm text-fg">{itemsLabel}</span>
          <span className="block truncate text-xs text-muted">
            {formatSellerDate(locale, order.created_at, true)} · {m.customer_name || t("unknownCustomer")}
            {m.shipping_address?.city ? ` · ${m.shipping_address.city}` : ""}
          </span>
          {m.tracking_number ? (
            <span className="flex items-center gap-1 text-xs text-muted">
              <Truck className="h-3 w-3" aria-hidden /> {m.tracking_carrier ? `${m.tracking_carrier} · ` : ""}
              {m.tracking_number}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-right">
          <span className="font-semibold text-fg">{formatSellerMoney(locale, order.total_cents, order.currency)}</span>
          <ChevronRight className="h-4 w-4 text-subtle" aria-hidden />
        </span>
      </button>
    </Card>
  );
}
