"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { Elements } from "@stripe/react-stripe-js";
import { loadStripe, type StripeElementsOptions } from "@stripe/stripe-js";
import { Package, ShoppingCart } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TextField } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { Link } from "@/lib/i18n/navigation";
import type { Currency } from "@/lib/i18n/config";
import type { CartSnapshot } from "@/lib/shop/cart";
import { OrderSummary } from "../OrderSummary";
import { useShopError } from "../useShopError";
import { PaymentStep } from "./PaymentStep";
import { isNativeApp } from "@/lib/native-app";
import { publishableKeyLooksValid } from "@/lib/shop/payments-config";
import { stripeAppearance } from "./stripe-appearance";

const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
// Cheie lipsă/placeholder → fără loadStripe("") (respingere netratată la încărcare);
// checkout-ul afișează „plăți indisponibile”.
const stripePromise = publishableKeyLooksValid(STRIPE_PUBLISHABLE_KEY) ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null;
const STRIPE_LOCALES = new Set(["de", "en", "es", "fr", "it", "pt", "ro"]);

type Intent = {
  clientSecret: string;
  orderId: string;
  orderLookupToken: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
};

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "needEmail" }
  | { status: "error"; message: string }
  | { status: "ready"; intent: Intent };

/**
 * Checkout: produsele (doar citire — se editează în coș), sumele calculate de
 * server, adresă + plată. Comanda e idempotentă pe server: reîncărcarea
 * paginii refolosește aceeași comandă cât timp coșul nu se schimbă.
 */
export function CheckoutView() {
  const t = useTranslations("shopBuyer");
  const locale = useLocale();
  const formatPrice = useFormatPrice();
  const errorMessage = useShopError();
  const [cart, setCart] = useState<CartSnapshot | null>(null);
  const [state, setState] = useState<State>({ status: "loading" });
  const [email, setEmail] = useState("");
  const started = useRef(false);

  const start = useCallback(
    async (withEmail?: string) => {
      setState({ status: "loading" });
      try {
        const cartRes = await fetch("/api/cart", { credentials: "include", cache: "no-store" });
        const snapshot = (await cartRes.json()) as CartSnapshot;
        setCart(snapshot);
        if (!snapshot.items?.length) {
          setState({ status: "empty" });
          return;
        }
        if (!stripePromise) {
          setState({ status: "error", message: errorMessage({ code: "payments_unavailable" }) });
          return;
        }
        const res = await fetch("/api/checkout/create-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ...(withEmail ? { email: withEmail } : {}), client: isNativeApp() ? "app" : "web" }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) setState({ status: "ready", intent: data as Intent });
        else if (data.code === "email_required") setState({ status: "needEmail" });
        else if (data.code === "cart_empty") setState({ status: "empty" });
        else setState({ status: "error", message: errorMessage(data) });
      } catch {
        setState({ status: "error", message: errorMessage({ code: "network" }) });
      }
    },
    [errorMessage],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const options = useMemo<StripeElementsOptions | null>(() => {
    if (state.status !== "ready") return null;
    return {
      clientSecret: state.intent.clientSecret,
      appearance: stripeAppearance(),
      locale: (STRIPE_LOCALES.has(locale) ? locale : "auto") as StripeElementsOptions["locale"],
    };
  }, [state, locale]);

  if (state.status === "empty") {
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
  if (state.status === "error") {
    return (
      <ErrorState
        title={state.message}
        description={t("checkout.errorHint")}
        onRetry={() => void start()}
      />
    );
  }
  if (state.status === "needEmail") {
    const onSubmit = (e: FormEvent) => {
      e.preventDefault();
      if (email.trim()) void start(email.trim());
    };
    return (
      <Card padding="md" className="mx-auto max-w-md">
        <form onSubmit={onSubmit} className="space-y-4">
          <TextField type="email" required autoComplete="email" label={t("checkout.emailLabel")} hint={t("checkout.emailHint")} value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" block size="lg">
            {t("checkout.emailContinue")}
          </Button>
        </form>
      </Card>
    );
  }

  const intent = state.status === "ready" ? state.intent : null;
  const items = cart?.items.filter((i) => i.purchasable) ?? [];

  return (
    <div className="pb-28 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-6 lg:pb-0">
      <div className="space-y-4">
        <Card padding="md">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-fg">{t("cart.itemCount", { count: items.reduce((s, i) => s + i.quantity, 0) })}</h2>
            <Link href="/cart" className="inline-flex min-h-[2.75rem] items-center text-sm text-brand">
              {t("checkout.editCart")}
            </Link>
          </div>
          <ul className="divide-y divide-subtle">
            {items.map((line) => (
              <li key={line.id} className="flex items-center gap-3 py-3">
                <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-control bg-surface-2">
                  {line.image ? (
                    <Image src={line.image} alt="" fill sizes="56px" className="object-cover" />
                  ) : (
                    <Package className="m-4 h-6 w-6 text-subtle" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm text-fg">{line.title}</span>
                  <span className="text-xs text-muted">
                    {t("orders.qtyUnit", { qty: line.quantity, unit: formatPrice(line.priceCents, { sourceCurrency: line.currency as Currency }) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {intent && options ? (
          <Elements stripe={stripePromise} options={options}>
            <PaymentStep
              orderId={intent.orderId}
              lookupToken={intent.orderLookupToken}
              nativeApp={isNativeApp()}
              payLabel={t("checkout.pay", { amount: formatPrice(intent.totalCents, { sourceCurrency: intent.currency as Currency }) })}
            />
          </Elements>
        ) : (
          <div className="space-y-3" aria-busy>
            <p className="text-sm text-muted">{t("checkout.preparing")}</p>
            <Skeleton className="h-56 rounded-card" />
          </div>
        )}
      </div>
      <div className="mt-4 lg:mt-0">
        {intent ? (
          <OrderSummary subtotalCents={intent.subtotalCents} shippingCents={intent.shippingCents} currency={intent.currency} className="lg:sticky lg:top-20" />
        ) : (
          <Skeleton className="h-40 rounded-card" />
        )}
      </div>
    </div>
  );
}
