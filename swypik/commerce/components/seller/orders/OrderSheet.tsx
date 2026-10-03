"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink, Printer } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { formatSellerDate, formatSellerMoney, shortOrderId } from "@/components/seller/format";
import type { SellerOrderAction } from "@/lib/seller/fulfilment";
import { OrderStateBadge } from "./OrderStateBadge";
import { ShipForm, type ShipInput } from "./ShipForm";
import type { SellerOrderRow } from "./types";

type Props = {
  order: SellerOrderRow | null;
  busy: SellerOrderAction | null;
  error: string | null;
  onClose: () => void;
  onAction: (action: Exclude<SellerOrderAction, "ship">) => void;
  onShip: (input: ShipInput) => void;
  onPrint: () => void;
};

/** Detaliile comenzii + acțiunile permise de starea ei (lib/seller/fulfilment). */
export function OrderSheet({ order, busy, error, onClose, onAction, onShip, onPrint }: Props) {
  const t = useTranslations("sellerPanel.orders");
  const locale = useLocale();
  const [shipping, setShipping] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (!order) return null;
  const m = order.order_metadata;
  const a = m.shipping_address ?? {};
  const can = (x: SellerOrderAction) => order.actions.includes(x);
  const money = (c: number) => formatSellerMoney(locale, c, order.currency);

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) {
          setShipping(false);
          onClose();
        }
      }}
      title={t("sheetTitle", { id: shortOrderId(order.order_id) })}
      description={formatSellerDate(locale, order.created_at, true)}
      footer={
        shipping ? null : (
          <div className="flex flex-wrap gap-2">
            {can("accept") ? (
              <Button className="flex-1" loading={busy === "accept"} onClick={() => onAction("accept")}>
                {t("actions.accept")}
              </Button>
            ) : null}
            {can("ship") ? (
              <Button className="flex-1" variant={can("accept") ? "secondary" : "primary"} onClick={() => setShipping(true)}>
                {t("actions.ship")}
              </Button>
            ) : null}
            {can("deliver") ? (
              <Button className="flex-1" loading={busy === "deliver"} onClick={() => onAction("deliver")}>
                {t("actions.deliver")}
              </Button>
            ) : null}
            {can("refund_return") ? (
              <Button className="flex-1" variant="danger" loading={busy === "refund_return"} onClick={() => onAction("refund_return")}>
                {t("actions.refundReturn")}
              </Button>
            ) : null}
            {can("cancel") ? (
              <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
                {t("actions.cancel")}
              </Button>
            ) : null}
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <OrderStateBadge state={order.state} />
          <span className="text-lg font-bold text-fg">{money(order.total_cents)}</span>
        </div>
        {error ? <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
        {shipping ? <ShipForm busy={busy === "ship"} onSubmit={onShip} onCancel={() => setShipping(false)} /> : null}

        <section>
          <h3 className="mb-1 text-sm font-semibold text-fg">{t("items")}</h3>
          <ul className="divide-y divide-subtle rounded-control border border-subtle">
            {order.items.map((i) => (
              <li key={i.item_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className={i.source_status === "cancelled" ? "min-w-0 text-subtle line-through" : "min-w-0 text-fg"}>
                  {i.quantity}× {i.title}
                </span>
                <span className="shrink-0 text-muted">{money(i.unit_amount_cents * i.quantity)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-fg">{t("customer")}</h3>
            <p className="text-sm text-fg">{m.customer_name || t("unknownCustomer")}</p>
            {m.customer_phone ? <p className="text-sm text-muted">{m.customer_phone}</p> : null}
            {m.customer_email ? <p className="break-all text-sm text-muted">{m.customer_email}</p> : null}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold text-fg">{t("address")}</h3>
            <p className="text-sm text-muted">
              {[a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" "), a.state, a.country].filter(Boolean).join(", ") || "—"}
            </p>
            {m.easybox_locker ? <p className="text-sm text-muted">{t("locker", { name: m.easybox_locker })}</p> : null}
          </div>
        </section>

        {m.tracking_number ? (
          <section className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm text-fg">
              {t("tracking", { carrier: m.tracking_carrier || t("carrierUnknown"), awb: m.tracking_number })}
            </p>
            {m.tracking_url ? (
              <Button asChild size="sm" variant="secondary">
                <a href={m.tracking_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden /> {t("track")}
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={onPrint}>
              <Printer className="h-4 w-4" aria-hidden /> {t("printLabel")}
            </Button>
          </section>
        ) : null}

        {m.return_reason ? (
          <section className="rounded-control bg-warning-soft px-3 py-2 text-sm text-warning">
            {t("returnReason", { reason: m.return_reason })}
          </section>
        ) : null}
      </div>

      <Dialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t("cancelTitle")}
        description={t("cancelBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              {t("cancelKeep")}
            </Button>
            <Button
              variant="danger"
              loading={busy === "cancel"}
              onClick={() => {
                setConfirmCancel(false);
                onAction("cancel");
              }}
            >
              {t("cancelConfirm")}
            </Button>
          </>
        }
      />
    </Sheet>
  );
}
