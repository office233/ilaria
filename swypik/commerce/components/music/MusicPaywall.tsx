"use client";
import { useEffect, useRef, useState } from "react";
import { waitForMusicAccess } from "./waitForMusicAccess";
import { useRouter } from "@/lib/i18n/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Lock, X } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement } from "@stripe/react-stripe-js";
import { useStripeSubmission } from "@/components/payments/useStripeSubmission";
import { haptic } from "@/lib/haptic";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import type { MusicLockedInfo } from "./MusicPlayerProvider";
import { useIsNativeApp } from "@/components/media/useIsNativeApp";
import { PURCHASE_UNAVAILABLE_IN_APP } from "@/lib/media/native-app";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

type UnlockTarget = "track" | "album";

type Props = {
  locked: MusicLockedInfo | null;
  onUnlocked: () => void;
  onClose: () => void;
  /**
   * Slug-ul albumului, dacă piesa face parte dintr-unul. 402-ul de pe
   * `/api/music/tracks/<slug>/play` nu îl întoarce (doar prețul) — paginile
   * care au deja `AlbumDto` (Task 11) îl pot pasa ca să afișeze și butonul
   * de deblocare a albumului întreg.
   */
  albumSlug?: string;
};

function ConfirmForm({ amountCents, onDone, onCancel }: { amountCents: number; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations("music");
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
      await onDone();
      return;
    }
    setError(t("error"));
  });

  return (
    <div className="space-y-3 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-wide text-white/60">{t("payWithCard")}</p>
        <button type="button" onClick={onCancel} disabled={busy} aria-label={t("close")} className="rounded-full bg-white/10 p-1.5 text-white/70 disabled:opacity-50">
          <X size={14} />
        </button>
      </div>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p role="alert" className="text-xs font-semibold text-amber-300">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy || !stripe || !elements}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black active:scale-95 disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
        {busy ? t("unlocking") : `${t("plateste")} ${formatPrice(amountCents, { sourceCurrency: "RON" })}`}
      </button>
    </div>
  );
}

/** Card de paywall: preț piesă/album în RON, plată cu cardul (Stripe Elements). */
export default function MusicPaywall({ locked, onUnlocked, onClose, albumSlug }: Props) {
  const t = useTranslations("music");
  const router = useRouter();
  const formatPrice = useFormatPrice();
  const [busy, setBusy] = useState<UnlockTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ target: UnlockTarget; clientSecret: string; amountCents: number } | null>(null);
  /** Plata e confirmată; așteptăm webhook-ul care dă accesul (altfel paywall-ul reapare). */
  const [waiting, setWaiting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    setPending(null);
    setWaiting(false);
    setNotice(null);
    return () => { abortRef.current?.abort(); };
  }, [locked?.track.slug]);
  const nativeApp = useIsNativeApp();

  if (!locked) return null;
  const { track, priceCents, albumPriceCents, requireAuth } = locked;

  const goLogin = () => router.push(`/auth?next=/music/track/${track.slug}`);

  const start = async (target: UnlockTarget) => {
    if (requireAuth) { goLogin(); return; }
    haptic("tap");
    setBusy(target);
    setNotice(null);
    try {
      const path = target === "track" ? `/api/music/tracks/${track.slug}/unlock` : `/api/music/albums/${albumSlug}/unlock`;
      const res = await fetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { goLogin(); return; }
      if (!res.ok) {
        setNotice(data.error === "price_not_set" ? t("priceComingSoon") : data.error === PURCHASE_UNAVAILABLE_IN_APP ? t("purchaseUnavailableInApp") : t("error"));
        return;
      }
      if (data.alreadyUnlocked) {
        onUnlocked();
        return;
      }
      setPending({ target, clientSecret: data.clientSecret, amountCents: data.amountCents });
    } catch {
      setNotice(t("error"));
    } finally {
      setBusy(null);
    }
  };

  if (pending) {
    return (
      <Elements stripe={stripePromise} options={{ clientSecret: pending.clientSecret, appearance: { theme: "night" } }}>
        <ConfirmForm
          amountCents={pending.amountCents}
          onCancel={() => setPending(null)}
          onDone={async () => {
            setPending(null);
            setWaiting(true);
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            const ok = await waitForMusicAccess(track.slug, controller.signal);
            if (controller.signal.aborted) return;
            setWaiting(false);
            if (ok) onUnlocked();
            else setNotice(t("paymentPendingSlow"));
          }}
        />
      </Elements>
    );
  }

  if (waiting) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card bg-elevated p-5 text-center text-fg" aria-live="polite">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        <p className="text-sm">{t("confirmingPayment")}</p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center gap-3 rounded-2xl bg-[#121218] p-5 text-center text-white ring-1 ring-white/10">
      <button type="button" onClick={onClose} aria-label={t("close")} className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white/70">
        <X size={16} />
      </button>
      <div className="grid h-12 w-12 place-items-center rounded-full bg-white/10 ring-1 ring-white/20">
        <Lock size={22} />
      </div>
      <p className="text-lg font-black">{t("locked")}</p>
      <p className="truncate text-sm text-white/70">{track.title} · {track.artist.stageName}</p>

      {nativeApp && <p className="text-sm text-white/70">{t("purchaseUnavailableInApp")}</p>}

      {!nativeApp && priceCents !== null && (
        <button
          type="button"
          onClick={() => start("track")}
          disabled={busy !== null}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black active:scale-95 disabled:opacity-50"
        >
          {busy === "track" ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
          {busy === "track" ? t("unlocking") : requireAuth ? t("loginToUnlock") : `${t("unlockTrack")} · ${formatPrice(priceCents, { sourceCurrency: "RON" })}`}
        </button>
      )}
      {!nativeApp && priceCents === null && <p className="text-xs text-white/60">{t("priceComingSoon")}</p>}

      {!nativeApp && albumPriceCents !== null && albumSlug && (
        <button
          type="button"
          onClick={() => start("album")}
          disabled={busy !== null}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white/10 px-5 py-3.5 text-sm font-black text-white ring-1 ring-white/20 active:scale-95 disabled:opacity-50"
        >
          {busy === "album" ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
          {busy === "album" ? t("unlocking") : requireAuth ? t("loginToUnlock") : `${t("unlockAlbum")} · ${formatPrice(albumPriceCents, { sourceCurrency: "RON" })}`}
        </button>
      )}

      {notice && <p className="text-xs text-amber-300">{notice}</p>}
    </div>
  );
}
