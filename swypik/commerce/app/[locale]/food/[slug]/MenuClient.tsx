"use client";

/**
 * Pagina restaurantului: meniu pe categorii, coș per restaurant, checkout,
 * plată prin calea existentă (EatsPaymentModal / Stripe Payment Element).
 * Restaurantele nerevendicate: UnclaimedMerchantView (sugerează / revendică).
 */
import { useCallback, useEffect, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import EatsPaymentModal from "@/components/payments/EatsPaymentModal";
import MerchantHero from "@/components/food/menu/MerchantHero";
import MenuSections from "@/components/food/menu/MenuSections";
import OptionPickerSheet from "@/components/food/menu/OptionPickerSheet";
import CheckoutSheet from "@/components/food/menu/CheckoutSheet";
import OrderPlaced from "@/components/food/menu/OrderPlaced";
import UnclaimedMerchantView from "@/components/food/UnclaimedMerchantView";
import { useCart } from "@/components/food/menu/useCart";
import { useCheckout, type CardPayment, type PlacedOrder } from "@/components/food/menu/useCheckout";
import { haptic } from "@/lib/haptic";
import type { CartLine, MenuItem, MenuSection, MerchantSummary } from "@/lib/food/types";

type Props = { merchant: MerchantSummary; signedIn: boolean; returnPath: string; cardAvailable: boolean };

/** După confirmPayment: serverul verifică hold-ul la Stripe (restaurantul vede comanda). */
async function confirmCardHold(order: PlacedOrder): Promise<void> {
  try {
    await fetch(`/api/local-orders/${order.id}/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(order.tracking_token ? { "x-order-token": order.tracking_token } : {}),
      },
      body: JSON.stringify({ action: "confirm" }),
    });
  } catch {
    /* best-effort: watchdog-ul sincronizează oricum */
  }
}

export default function MenuClient({ merchant, signedIn, returnPath, cardAvailable }: Props) {
  const t = useTranslations("foodHub");
  const fmt = useFormatPrice();
  const [menu, setMenu] = useState<MenuSection[]>([]);
  const [menuState, setMenuState] = useState<"loading" | "ok" | "error">("loading");
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [cardPay, setCardPay] = useState<{ payment: CardPayment; order: PlacedOrder } | null>(null);
  const cart = useCart(merchant.id);
  const co = useCheckout({
    merchantId: merchant.id,
    fixedFeeCents: merchant.delivery_fee_cents ?? 0,
    open: checkoutOpen,
    lines: cart.lines,
    subtotal: cart.subtotal,
    cardAvailable,
  });
  const canOrder = merchant.is_orderable && merchant.is_open === true;
  const minOrder = merchant.min_order_cents ?? 0;
  const belowMin = cart.subtotal > 0 && cart.subtotal < minOrder;

  const loadMenu = useCallback(() => {
    setMenuState("loading");
    fetch(`/api/merchants/${merchant.id}/menu`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { success?: boolean; menu?: MenuSection[] }) => {
        setMenu(d.menu ?? []);
        setMenuState(d.success ? "ok" : "error");
      })
      .catch(() => setMenuState("error"));
  }, [merchant.id]);

  useEffect(() => {
    if (merchant.is_orderable) loadMenu();
  }, [merchant.is_orderable, loadMenu]);

  // Re-comandă: ?reorder=<order_id> → coșul din comanda veche (serverul recalculează prețurile).
  const { replace } = cart;
  useEffect(() => {
    const reorderId = new URLSearchParams(window.location.search).get("reorder");
    if (!reorderId || !merchant.is_orderable) return;
    fetch(`/api/local-orders/${reorderId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { success?: boolean; order?: { merchant?: { id: string }; items?: (CartLine & { options?: { id?: string; name: string }[] })[] } }) => {
        if (!d.success || d.order?.merchant?.id !== merchant.id) return;
        const lines: CartLine[] = (d.order.items ?? []).map((it) => ({
          menu_item_id: it.menu_item_id,
          name: it.name,
          unit_price_cents: it.unit_price_cents,
          qty: it.qty,
          option_ids: (it.options ?? []).map((o) => o.id ?? o.name),
          option_names: (it.options ?? []).map((o) => o.name),
        }));
        if (lines.length) replace(lines);
      })
      .catch(() => undefined);
  }, [merchant.id, merchant.is_orderable, replace]);

  const pick = (item: MenuItem) => {
    if ((item.options ?? []).length) setPicker(item);
    else {
      cart.add(item, []);
      haptic("success");
    }
  };

  const submit = async () => {
    const r = await co.place();
    if (!r) return;
    cart.clear();
    setCheckoutOpen(false);
    if (r.payment?.client_secret) setCardPay({ payment: r.payment, order: r.order });
    else setPlaced(r.order);
  };

  if (cardPay) {
    const done = () => {
      setPlaced(cardPay.order);
      setCardPay(null);
    };
    const paid = () => {
      void confirmCardHold(cardPay.order);
      done();
    };
    // Anularea modalului lasă comanda plasată cu plata „pending”: restaurantul nu o
    // poate accepta până la plată, iar clientul o poate anula din pagina de tracking.
    return <EatsPaymentModal clientSecret={cardPay.payment.client_secret} amountCents={cardPay.payment.amount_cents} onSuccess={paid} onCancel={done} />;
  }
  if (placed) return <OrderPlaced order={placed} merchantName={merchant.name} />;

  return (
    <div className="min-h-dvh bg-canvas pb-28">
      <MerchantHero m={merchant} deliveryFeeCents={merchant.delivery_fee_cents} />

      {!merchant.is_orderable ? (
        <UnclaimedMerchantView m={merchant} signedIn={signedIn} returnPath={returnPath} />
      ) : (
        <main className="px-gutter pt-4">
          {!canOrder ? (
            <p className="mb-3 rounded-control bg-warning-soft px-3 py-2 text-sm font-semibold text-warning">
              {merchant.hours_known ? t("closedNotice") : t("hoursUnknownNotice")}
            </p>
          ) : null}
          {menuState === "loading" ? (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-card" />)}
            </div>
          ) : menuState === "error" ? (
            <ErrorState title={t("menuLoadError")} onRetry={loadMenu} />
          ) : menu.length === 0 ? (
            <EmptyState title={t("menuSoon")} description={t("menuSoonSub")} />
          ) : (
            <MenuSections sections={menu} canOrder={canOrder} onPick={pick} />
          )}
        </main>
      )}

      {merchant.is_orderable && cart.lines.length > 0 ? (
        <div className="fixed inset-x-0 z-header border-t border-subtle bg-surface/95 px-gutter py-3 backdrop-blur-xl" style={{ bottom: "var(--bottom-inset)" }}>
          {belowMin ? (
            <p className="mb-2 text-center text-sm font-semibold text-warning">
              {t("minOrderWarning", { min: fmt(minOrder), diff: fmt(minOrder - cart.subtotal) })}
            </p>
          ) : null}
          <Button block size="lg" disabled={belowMin || !canOrder} onClick={() => setCheckoutOpen(true)} className="justify-between">
            <span className="inline-flex items-center gap-2">
              <ShoppingBag size={18} aria-hidden />
              {t("itemsCount", { count: cart.count })}
            </span>
            <span>{fmt(cart.subtotal)}</span>
          </Button>
        </div>
      ) : null}

      <OptionPickerSheet
        item={picker}
        onClose={() => setPicker(null)}
        onAdd={(item, ids) => {
          cart.add(item, ids);
          haptic("success");
          setPicker(null);
        }}
      />
      <CheckoutSheet
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        lines={cart.lines}
        subtotal={cart.subtotal}
        onQty={cart.changeQty}
        co={co}
        onSubmit={() => void submit()}
      />
    </div>
  );
}
