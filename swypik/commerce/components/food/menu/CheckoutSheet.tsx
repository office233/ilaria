"use client";

/** Checkout Food: coș (cantități), totaluri, livrare, bacșiș, metodă de plată, plasare. */
import { Banknote, CreditCard, Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { cn } from "@/lib/ui/cn";
import { haptic } from "@/lib/haptic";
import type { CartLine } from "@/lib/food/types";
import DeliveryFields from "./DeliveryFields";
import { TIP_PRESETS, type useCheckout } from "./useCheckout";
import { useFoodError } from "../useFoodError";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: CartLine[];
  subtotal: number;
  onQty: (index: number, delta: number) => void;
  co: ReturnType<typeof useCheckout>;
  onSubmit: () => void;
};

const choice = (active: boolean) =>
  cn("inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-control border text-sm font-semibold", active ? "border-brand bg-brand-soft text-brand-soft-fg" : "border-subtle text-fg");

export default function CheckoutSheet({ open, onOpenChange, lines, subtotal, onQty, co, onSubmit }: Props) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const errorText = useFoodError();
  const row = "flex justify-between text-sm text-muted";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("checkoutTitle")}
      footer={
        <div className="space-y-2">
          {co.errorCode ? <p role="alert" className="text-sm font-semibold text-danger">{errorText(co.errorCode)}</p> : null}
          <Button block size="lg" loading={co.placing} disabled={!co.valid} onClick={onSubmit}>
            {t("submitOrder", { total: fmt(co.total) })}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <ul className="space-y-2 rounded-card bg-surface-2 p-3">
          {lines.map((l, i) => (
            <li key={`${l.menu_item_id}-${i}`} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-fg">{l.name}</p>
                {l.option_names.length ? <p className="truncate text-xs text-muted">{l.option_names.join(", ")}</p> : null}
              </div>
              <IconButton size="sm" variant="secondary" label={t("decrease")} onClick={() => { haptic("tap"); onQty(i, -1); }}>
                <Minus aria-hidden />
              </IconButton>
              <span className="w-6 text-center text-sm font-bold text-fg">{l.qty}</span>
              <IconButton size="sm" variant="secondary" label={t("increase")} onClick={() => { haptic("tap"); onQty(i, 1); }}>
                <Plus aria-hidden />
              </IconButton>
              <span className="w-20 text-right text-sm font-bold text-fg">{fmt(l.unit_price_cents * l.qty)}</span>
            </li>
          ))}
          <li className="space-y-1 border-t border-subtle pt-2">
            <div className={row}><span>{t("subtotal")}</span><span>{fmt(subtotal)}</span></div>
            <div className={row}><span>{t("delivery")}</span><span>{co.deliveryFee === 0 ? t("freeDelivery") : fmt(co.deliveryFee)}</span></div>
            {co.tip.tipCents > 0 ? <div className={row}><span>{t("courierTip")}</span><span>{fmt(co.tip.tipCents)}</span></div> : null}
            <div className="flex justify-between text-sm font-bold text-fg"><span>{t("total")}</span><span>{fmt(co.total)}</span></div>
          </li>
        </ul>

        <DeliveryFields f={co.fields} outOfRange={co.outOfRange} needsLocation={co.needsLocation} />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">{t("tipTitle")}</legend>
          <div className="flex gap-2">
            {TIP_PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={!co.tip.tipCustom && co.tip.tipPct === p} onClick={() => { co.tip.setTipPct(p); co.tip.setTipCustom(""); }} className={choice(!co.tip.tipCustom && co.tip.tipPct === p)}>
                {p === 0 ? t("noTip") : `${p}%`}
              </button>
            ))}
            <Input
              aria-label={t("tipCustom")}
              value={co.tip.tipCustom}
              onChange={(e) => co.tip.setTipCustom(e.target.value.replace(/[^\d.,]/g, ""))}
              placeholder={t("tipCustom")}
              inputMode="decimal"
              className="w-20 text-center"
            />
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-fg">{t("paymentTitle")}</legend>
          <div className="flex gap-2">
            <button type="button" aria-pressed={co.payMethod === "cash"} onClick={() => co.setPayMethod("cash")} className={choice(co.payMethod === "cash")}>
              <Banknote size={16} aria-hidden /> {t("payCash")}
            </button>
            {co.cardAvailable ? (
              <button type="button" aria-pressed={co.payMethod === "card_online"} onClick={() => co.setPayMethod("card_online")} className={choice(co.payMethod === "card_online")}>
                <CreditCard size={16} aria-hidden /> {t("payCard")}
              </button>
            ) : null}
          </div>
        </fieldset>
      </div>
    </Sheet>
  );
}
