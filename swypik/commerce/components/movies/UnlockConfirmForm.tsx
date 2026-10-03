"use client";
import { Lock, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { PaymentElement } from "@stripe/react-stripe-js";
import { useStripeSubmission } from "@/components/payments/useStripeSubmission";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";

type Props = {
  /** Suma venită de la server (sursa de adevăr), nu prețul afișat pe card. */
  amountCents: number;
  onConfirmed: () => void;
  onCancel: () => void;
};

/** Formularul Stripe Elements: confirmă plata; accesul vine separat, din webhook. */
export default function UnlockConfirmForm({ amountCents, onConfirmed, onCancel }: Props) {
  const t = useTranslations("movies");
  const formatPrice = useFormatPrice();
  const { stripe, elements, busy, error, setError, submitPayment } = useStripeSubmission(t("error"), t("error"));

  const submit = () => submitPayment(async (stripe, elements) => {
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      // Doar card (server): 3DS rulează în modal; return_url e plasa pentru orice redirect.
      confirmParams: { return_url: window.location.href },
    });
    if (confirmError) {
      setError(confirmError.message || t("error"));
      return;
    }
    if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "processing") {
      await onConfirmed();
      return;
    }
    setError(t("error"));
  });

  return (
    <div className="space-y-3 rounded-card bg-surface-2 p-4 text-left">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("payWithCard")}</p>
        <IconButton label={t("close")} onClick={onCancel} disabled={busy} className="-mr-2">
          <X aria-hidden />
        </IconButton>
      </div>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p role="alert" className="text-sm text-warning">{error}</p>}
      <Button block size="lg" onClick={submit} loading={busy} disabled={!stripe || !elements}>
        {!busy && <Lock className="h-4 w-4" aria-hidden />}
        {busy ? t("unlocking") : `${t("plateste")} ${formatPrice(amountCents, { sourceCurrency: "RON" })}`}
      </Button>
    </div>
  );
}
