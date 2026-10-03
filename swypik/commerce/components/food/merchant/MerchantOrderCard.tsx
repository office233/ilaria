"use client";

/** O comandă în panoul restaurantului: detalii + acceptă / refuză / în preparare / gata / anulează / curier. */
import { useState } from "react";
import { Bike, Phone } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { merchantNextActions } from "@/lib/food/order-status";
import type { MerchantOrder } from "./useMerchantOrders";

type Props = {
  o: MerchantOrder;
  onStatus: (orderId: string, status: string, reason?: string) => Promise<void>;
  onFindCourier: (orderId: string) => Promise<void>;
};

const COURIER_SEARCHABLE = ["accepted", "preparing", "ready"];

export default function MerchantOrderCard({ o, onStatus, onFindCourier }: Props) {
  const t = useTranslations("foodMerchant");
  const fmt = useFormatPrice();
  const [busy, setBusy] = useState<string | null>(null);
  const [stopOpen, setStopOpen] = useState<"rejected" | "cancelled" | null>(null);
  const [reason, setReason] = useState("");
  const actions = merchantNextActions(o.status);
  const forward = actions.filter((a) => a !== "rejected" && a !== "cancelled");
  const stop = actions.includes("rejected") ? "rejected" : actions.includes("cancelled") ? "cancelled" : null;
  // Card: hold autorizat = se încasează la „Acceptă" (audit #7); fără hold nu se poate accepta.
  const authorizedCard = o.payment_method === "card_online" && o.payment_status !== "paid" && Boolean(o.payment_authorized_at);
  const unpaidCard = o.payment_method === "card_online" && o.payment_status !== "paid" && !authorizedCard;
  const canDispatch = COURIER_SEARCHABLE.includes(o.status) && !o.courier_id && ["none", "no_courier", null].includes(o.dispatch_status);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold text-fg">{o.order_number}</span>
          <Badge tone={o.status === "placed" ? "warning" : "brand"}>{t(`status.${o.status}`)}</Badge>
        </div>
        <span className="text-sm font-bold text-fg">{fmt(o.total_cents)}</span>
      </div>
      <ul className="space-y-0.5 text-sm text-fg">
        {o.items.map((it, i) => (
          <li key={i}>
            {it.qty}× {it.name}
            {it.options?.length ? <span className="text-muted"> — {it.options.map((x) => x.name).join(", ")}</span> : null}
          </li>
        ))}
      </ul>
      <div className="space-y-0.5 text-sm text-muted">
        <p>{o.customer_name} · <a className="underline" href={`tel:${o.customer_phone}`}><Phone size={12} className="inline" aria-hidden /> {o.customer_phone}</a></p>
        <p>{o.delivery_address}</p>
        {o.delivery_notes ? <p className="italic">{o.delivery_notes}</p> : null}
        <p>{t(`payment.${o.payment_method === "card_online" ? (unpaidCard ? "cardPending" : authorizedCard ? "cardAuthorized" : "cardPaid") : "cash"}`)}</p>
        {o.dispatch_status && o.dispatch_status !== "none" ? <p>{t(`dispatch.${o.dispatch_status}`)}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {forward.map((s) => (
          <Button key={s} size="md" loading={busy === s} disabled={!!busy || (s === "accepted" && unpaidCard)} onClick={() => void run(s, () => onStatus(o.id, s))}>
            {t(`action.${s}`)}
          </Button>
        ))}
        {canDispatch ? (
          <Button size="md" variant="secondary" loading={busy === "dispatch"} disabled={!!busy} onClick={() => void run("dispatch", () => onFindCourier(o.id))}>
            <Bike size={16} aria-hidden /> {t(o.dispatch_status === "no_courier" ? "retryCourier" : "findCourier")}
          </Button>
        ) : null}
        {stop ? (
          <Button size="md" variant="ghost" disabled={!!busy} onClick={() => setStopOpen(stop)} className="text-danger">
            {t(`action.${stop}`)}
          </Button>
        ) : null}
      </div>
      <Dialog
        open={stopOpen !== null}
        onOpenChange={(v) => !v && setStopOpen(null)}
        title={stopOpen ? t(`confirm.${stopOpen}`) : ""}
        description={o.payment_method === "card_online" ? t("refundNote") : undefined}
        footer={
          <Button
            variant="danger"
            loading={busy === "stop"}
            onClick={() => stopOpen && void run("stop", async () => { await onStatus(o.id, stopOpen, reason.trim()); setStopOpen(null); setReason(""); })}
          >
            {stopOpen ? t(`action.${stopOpen}`) : ""}
          </Button>
        }
      >
        <Textarea aria-label={t("reason")} placeholder={t("reason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
    </Card>
  );
}
