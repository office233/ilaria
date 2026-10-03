"use client";

/** Sumarul comenzii + starea plății / rambursării. */
import { useTranslations } from "next-intl";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { TrackedOrder } from "./useOrderTracking";

export function paymentNoteKey(o: Pick<TrackedOrder, "payment_method" | "payment_status" | "refund_status" | "status">): string {
  if (o.payment_method !== "card_online") return "payCashNote";
  if (o.refund_status === "succeeded" || o.payment_status === "refunded") return "refundDone";
  if (o.refund_status === "pending") return "refundPending";
  if (o.refund_status === "failed") return "refundFailed";
  if (o.status === "cancelled" || o.status === "rejected") return "notCharged";
  return o.payment_status === "paid" ? "paidCard" : "cardPending";
}

export default function OrderSummaryCard({ order }: { order: TrackedOrder }) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const row = "flex justify-between text-sm text-muted";
  return (
    <section className="rounded-card border border-subtle bg-surface p-4" aria-labelledby="order-summary">
      <h2 id="order-summary" className="text-sm font-bold text-fg">{t("yourOrder")}</h2>
      <ul className="mt-2 space-y-1.5">
        {order.items.map((it, i) => (
          <li key={i} className="flex justify-between gap-2 text-sm">
            <span className="text-fg">
              {it.qty}× {it.name}
              {it.options?.length ? <span className="block text-xs text-muted">{it.options.map((o) => o.name).join(", ")}</span> : null}
            </span>
            <span className="shrink-0 font-semibold text-fg">{fmt(it.unit_price_cents * it.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1 border-t border-subtle pt-2">
        <div className={row}><span>{t("subtotal")}</span><span>{fmt(order.subtotal_cents)}</span></div>
        <div className={row}><span>{t("delivery")}</span><span>{order.delivery_fee_cents === 0 ? t("freeDelivery") : fmt(order.delivery_fee_cents)}</span></div>
        {order.tip_cents > 0 ? <div className={row}><span>{t("courierTip")}</span><span>{fmt(order.tip_cents)}</span></div> : null}
        <div className="flex justify-between text-sm font-bold text-fg"><span>{t("total")}</span><span>{fmt(order.total_cents)}</span></div>
        <p className="pt-1 text-xs text-muted">{t(`payment.${paymentNoteKey(order)}`)}</p>
      </div>
    </section>
  );
}
