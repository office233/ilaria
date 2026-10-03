"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Lock } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { fetchMissions, postJson, useErrorMessage, useFormatRon, type ManagedMission } from "./shared";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

/** Webhook-ul Stripe activează misiunea; verificăm de câteva ori, apoi renunțăm politicos. */
const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 12;

type Phase = "intent" | "pay" | "activating" | "funded" | "slow" | "error";

type Props = {
  mission: ManagedMission | null;
  onOpenChange: (open: boolean) => void;
  onFunded: () => void;
};

function PayForm({ amountLabel, onPaid }: { amountLabel: string; onPaid: () => void }) {
  const t = useTranslations("sellerMissions");
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message || t("errors.payment_failed"));
      setBusy(false);
      return;
    }
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      // Metodele cu redirect (3DS extern, bancă) revin aici; aceeași origine și în WebView-ul app-ului.
      confirmParams: { return_url: `${window.location.origin}/seller/missions` },
    });
    if (confirmError) {
      setError(confirmError.message || t("errors.payment_failed"));
      setBusy(false);
      return;
    }
    if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "processing") {
      onPaid();
      return;
    }
    setError(t("errors.payment_failed"));
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error ? <p className="text-sm font-medium text-danger" role="alert">{error}</p> : null}
      <Button block size="lg" loading={busy} disabled={!stripe || !elements} onClick={() => void pay()}>
        <Lock className="h-4 w-4" aria-hidden /> {t("fund.pay", { amount: amountLabel })}
      </Button>
    </div>
  );
}

export function FundMissionSheet({ mission, onOpenChange, onFunded }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const errorMessage = useErrorMessage();
  const [phase, setPhase] = useState<Phase>("intent");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState(0);
  const [errorText, setErrorText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const missionId = mission?.id ?? null;
  const dark = useRef(false);
  // Ref ca efectul de creare a PaymentIntent-ului să nu depindă de identitatea funcției.
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;

  useEffect(() => {
    if (!missionId) return;
    let cancelled = false;
    const root = document.documentElement;
    dark.current =
      root.dataset.theme === "dark" ||
      (root.dataset.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setPhase("intent");
    setClientSecret(null);
    postJson<{ clientSecret?: string; amountCents?: number }>(`/api/seller/missions/${missionId}/fund`).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok || !data.clientSecret) {
        setErrorText(errorMessageRef.current(data.error));
        setPhase("error");
        return;
      }
      setClientSecret(data.clientSecret);
      setAmountCents(data.amountCents ?? 0);
      setPhase("pay");
    });
    return () => {
      cancelled = true;
    };
  }, [missionId, attempt]);

  useEffect(() => {
    if (phase !== "activating" || !missionId) return;
    let cancelled = false;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      const list = await fetchMissions().catch(() => null);
      if (cancelled) return;
      if (list?.find((m) => m.id === missionId)?.fundingStatus === "funded") {
        setPhase("funded");
        onFunded();
        return;
      }
      if (tries >= POLL_ATTEMPTS) {
        setPhase("slow");
        onFunded();
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    let timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, missionId, onFunded]);

  return (
    <Sheet
      open={mission !== null}
      onOpenChange={onOpenChange}
      title={t("fund.title")}
      description={mission ? t("fund.description", { title: mission.title }) : undefined}
    >
      {phase === "intent" ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : phase === "error" ? (
        <ErrorState description={errorText} onRetry={() => setAttempt((n) => n + 1)} />
      ) : phase === "pay" && clientSecret ? (
        <div className="space-y-4">
          <p className="rounded-control bg-surface-2 p-3 text-sm text-muted">
            {t("fund.escrowNote", { amount: ron(amountCents) })}
          </p>
          <Elements
            stripe={stripePromise}
            options={{ clientSecret, appearance: { theme: dark.current ? "night" : "stripe" } }}
          >
            <PayForm amountLabel={ron(amountCents)} onPaid={() => setPhase("activating")} />
          </Elements>
        </div>
      ) : (
        <div className="flex flex-col items-center py-8 text-center" role="status">
          {phase === "funded" ? (
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
          ) : (
            <Skeleton className="h-10 w-10 rounded-full" />
          )}
          <p className="mt-3 font-semibold text-fg">{t(`fund.${phase === "funded" ? "funded" : phase === "slow" ? "slow" : "activating"}`)}</p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            {t(`fund.${phase === "funded" ? "fundedHint" : phase === "slow" ? "slowHint" : "activatingHint"}`)}
          </p>
          {phase === "funded" || phase === "slow" ? (
            <Button className="mt-5" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("fund.done")}
            </Button>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
