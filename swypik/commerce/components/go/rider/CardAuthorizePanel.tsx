"use client";

/**
 * Autorizarea cardului ÎNAINTE de dispatch: hold pe plafonul tarifului
 * (capture manual). După confirmPayment, serverul verifică la Stripe
 * (`requires_capture`) și abia atunci caută șofer.
 */
import { useEffect, useState, type FormEvent } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { stripeAppearance } from "@/components/shop/checkout/stripe-appearance";
import { goErrorKey, goFetch, useGoFormat } from "../format";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

type Props = { rideId: string; currency: string; onAuthorized: () => void };

function ConfirmForm({ rideId, amountCents, currency, onAuthorized }: Props & { amountCents: number }) {
  const t = useTranslations("go");
  const f = useGoFormat();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: err, paymentIntent } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (err || !paymentIntent || paymentIntent.status !== "requires_capture") {
      setBusy(false);
      setError(err?.message ?? t("errors.payment_not_authorized"));
      return;
    }
    const r = await goFetch("/api/rides/" + rideId + "/pay", { method: "POST", body: JSON.stringify({ action: "confirm" }) });
    setBusy(false);
    if (!r.ok) {
      setError(t(goErrorKey(r.error)));
      return;
    }
    onAuthorized();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <PaymentElement options={{ layout: "tabs" }} />
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" block size="lg" loading={busy} disabled={!stripe}>
        <Lock aria-hidden className="h-4 w-4" />
        {t("pay.authorize", { amount: f.money(amountCents, currency) })}
      </Button>
      <p className="text-center text-xs text-muted">{t("pay.holdExplainer")}</p>
    </form>
  );
}

export default function CardAuthorizePanel(props: Props) {
  const t = useTranslations("go");
  const [intent, setIntent] = useState<{ client_secret: string; amount_cents: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    void goFetch<{ client_secret: string; amount_cents: number }>(`/api/rides/${props.rideId}/pay`, {
      method: "POST",
      body: JSON.stringify({ action: "authorize" }),
    }).then((r) => {
      if (!alive) return;
      if (r.ok) setIntent(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [props.rideId, attempt]);

  if (error) {
    return <ErrorState description={t(goErrorKey(error))} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  if (!intent) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold text-fg">{t("pay.title")}</h2>
      <Elements stripe={stripePromise} options={{ clientSecret: intent.client_secret, appearance: stripeAppearance() }}>
        <ConfirmForm {...props} amountCents={intent.amount_cents} />
      </Elements>
    </div>
  );
}
