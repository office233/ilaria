"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/i18n/navigation";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { haptic } from "@/lib/haptic";
import { pollUntil } from "@/lib/media/poll";
import { Button } from "@/components/ui/Button";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import UnlockConfirmForm from "./UnlockConfirmForm";
import { useIsNativeApp } from "@/components/media/useIsNativeApp";
import { PURCHASE_UNAVAILABLE_IN_APP } from "@/lib/media/native-app";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

type Target = { episodeId: string } | { season: true };

type Props = {
  slug: string;
  target: Target;
  /** `null` = prețul RON nu a fost încă setat de creator ("preț în curând"). */
  priceCents: number | null;
  label: string;
  onUnlocked: () => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "form"; clientSecret: string; amountCents: number }
  /** Plata e confirmată la Stripe; așteptăm webhook-ul care dă accesul. */
  | { kind: "waiting" }
  | { kind: "slow" };

function statusUrl(slug: string, target: Target): string {
  return "episodeId" in target ? `/api/movies/${slug}/unlock?episodeId=${target.episodeId}` : `/api/movies/${slug}/unlock`;
}

export default function UnlockButton({ slug, target, priceCents, label, onUnlocked }: Props) {
  const t = useTranslations("movies");
  const router = useRouter();
  const formatPrice = useFormatPrice();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const nativeApp = useIsNativeApp();
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    haptic("tap");
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/movies/${slug}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.push(`/auth?next=/movies/${slug}`);
        return;
      }
      if (!res.ok) {
        setNotice(
          data.error === "price_not_set" ? t("priceComingSoon") : data.error === PURCHASE_UNAVAILABLE_IN_APP ? t("purchaseUnavailableInApp") : t("error"),
        );
        return;
      }
      if (data.alreadyUnlocked) {
        onUnlocked();
        return;
      }
      setPhase({ kind: "form", clientSecret: data.clientSecret, amountCents: data.amountCents });
    } catch {
      setNotice(t("error"));
    } finally {
      setBusy(false);
    }
  };

  // După confirmare: așteptăm ca webhook-ul să marcheze deblocarea `paid`,
  // abia apoi reîncărcăm playerul (altfel userul vede din nou paywall-ul).
  const waitForAccess = async () => {
    setPhase({ kind: "waiting" });
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const result = await pollUntil(
      () => fetch(statusUrl(slug, target), { cache: "no-store", signal: ctrl.signal }).then((r) => r.json() as Promise<{ status?: string }>),
      (d) => d.status === "paid",
      { signal: ctrl.signal },
    );
    if (ctrl.signal.aborted) return;
    if (result) {
      haptic("success");
      setPhase({ kind: "idle" });
      onUnlocked();
    } else {
      setPhase({ kind: "slow" });
    }
  };

  if (phase.kind === "form") {
    return (
      <Elements stripe={stripePromise} options={{ clientSecret: phase.clientSecret, appearance: { theme: "night" } }}>
        <UnlockConfirmForm amountCents={phase.amountCents} onConfirmed={waitForAccess} onCancel={() => setPhase({ kind: "idle" })} />
      </Elements>
    );
  }
  if (phase.kind === "waiting" || phase.kind === "slow") {
    return (
      <div className="space-y-2 rounded-card bg-surface-2 p-4 text-center" aria-live="polite">
        <p className="text-sm text-fg">{phase.kind === "waiting" ? t("confirmingPayment") : t("paymentPendingSlow")}</p>
        <Button block variant="secondary" loading={phase.kind === "waiting"} onClick={waitForAccess} disabled={phase.kind === "waiting"}>
          {t("checkAgain")}
        </Button>
      </div>
    );
  }

  // Aplicația nativă: conținutul digital nu se vinde în afara IAP (reguli App Store / Play).
  if (nativeApp) {
    return <p className="rounded-card bg-surface-2 p-4 text-center text-sm text-muted">{t("purchaseUnavailableInApp")}</p>;
  }

  return (
    <div className="space-y-2">
      <Button block size="lg" onClick={start} loading={busy} disabled={priceCents === null}>
        {!busy && <Lock className="h-4 w-4" aria-hidden />}
        {busy
          ? t("unlocking")
          : priceCents === null
            ? t("priceComingSoon")
            : `${label} · ${formatPrice(priceCents, { sourceCurrency: "RON" })}`}
      </Button>
      {notice && <p role="alert" className="text-center text-sm text-warning">{notice}</p>}
    </div>
  );
}
