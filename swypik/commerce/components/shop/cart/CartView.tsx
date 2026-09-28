"use client";

import { useCallback, useEffect, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog, DialogClose } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { Link } from "@/lib/i18n/navigation";
import type { Currency } from "@/lib/i18n/config";
import type { CartSnapshot } from "@/lib/shop/cart";
import { OrderSummary } from "../OrderSummary";
import { useShopError } from "../useShopError";
import { CartLineItem } from "./CartLineItem";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; cart: CartSnapshot };

/** Coșul: linii editabile (după id, nu după index), golire cu confirmare, bară fixă spre checkout. */
export function CartView({ maxLineQty }: { maxLineQty: number }) {
  const t = useTranslations("shopBuyer");
  const formatPrice = useFormatPrice();
  const { toast } = useToast();
  const errorMessage = useShopError();
  const [state, setState] = useState<State>({ status: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/cart", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setState({ status: "ready", cart: (await res.json()) as CartSnapshot });
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (itemId: string, init: RequestInit) => {
    setBusyId(itemId);
    try {
      const res = await fetch(`/api/cart/items/${itemId}`, { ...init, credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: errorMessage(data), tone: "danger" });
        return;
      }
      setState({ status: "ready", cart: data as CartSnapshot });
    } catch {
      toast({ title: errorMessage({ code: "network" }), tone: "danger" });
    } finally {
      setBusyId(null);
    }
  };

  const clearCart = async () => {
    setClearOpen(false);
    const res = await fetch("/api/cart", { method: "DELETE", credentials: "include" }).catch(() => null);
    if (res?.ok) await load();
    else toast({ title: errorMessage({ code: "network" }), tone: "danger" });
  };

  if (state.status === "loading") {
    return (
      <div className="space-y-4" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-20 w-20 rounded-control" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-11 w-32" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (state.status === "error") return <ErrorState title={t("cart.errorTitle")} onRetry={() => void load()} />;

  const { cart } = state;
  if (cart.items.length === 0) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title={t("cart.emptyTitle")}
        description={t("cart.emptyBody")}
        action={
          <Button asChild>
            <Link href="/shop">{t("cart.browse")}</Link>
          </Button>
        }
      />
    );
  }

  const blocked = cart.items.some((i) => !i.purchasable);
  const count = cart.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <div className="pb-28 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-6 lg:pb-0">
      <Card padding="none" className="px-4">
        <div className="flex items-center justify-between border-b border-subtle py-3">
          <p className="text-sm text-muted">{t("cart.itemCount", { count })}</p>
          <Dialog
            open={clearOpen}
            onOpenChange={setClearOpen}
            title={t("cart.clearTitle")}
            description={t("cart.clearBody")}
            trigger={
              <Button variant="ghost" size="sm">
                {t("cart.clear")}
              </Button>
            }
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t("cart.cancel")}</Button>
                </DialogClose>
                <Button variant="danger" onClick={() => void clearCart()}>
                  {t("cart.clearConfirm")}
                </Button>
              </>
            }
          />
        </div>
        <ul className="divide-y divide-subtle">
          {cart.items.map((line) => (
            <CartLineItem
              key={line.id}
              line={line}
              maxLineQty={maxLineQty}
              busy={busyId === line.id}
              onQuantity={(qty) =>
                void mutate(line.id, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ quantity: qty }),
                })
              }
              onRemove={() => void mutate(line.id, { method: "DELETE" })}
            />
          ))}
        </ul>
      </Card>

      <div className="mt-4 space-y-3 lg:mt-0">
        <OrderSummary subtotalCents={cart.subtotalCents} shippingCents={null} currency={cart.currency} />
        {blocked ? <p className="text-sm text-danger">{t("cart.removeUnavailable")}</p> : null}
      </div>

      <div
        className="fixed inset-x-0 z-header border-t border-subtle bg-surface/95 px-gutter py-3 shadow-elev-3 backdrop-blur-xl lg:static lg:col-span-2 lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none"
        style={{ bottom: "var(--bottom-inset)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">{t("summary.subtotal")}</p>
            <p className="text-lg font-semibold tabular-nums text-fg">
              {formatPrice(cart.subtotalCents, { sourceCurrency: cart.currency as Currency })}
            </p>
          </div>
          {blocked ? (
            <Button size="lg" disabled>
              {t("cart.checkout")}
            </Button>
          ) : (
            <Button asChild size="lg">
              <Link href="/checkout">{t("cart.checkout")}</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
