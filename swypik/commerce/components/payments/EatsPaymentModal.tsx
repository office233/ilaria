"use client";

/**
 * Plata cu cardul a unei comenzi Food (Stripe Payment Element).
 *
 * Primește client_secret-ul PaymentIntent-ului creat server-side la plasarea
 * comenzii (POST /api/local-orders cu payment_method='card_online') și
 * confirmă plata fără redirect (redirect: "if_required" — 3DS deschide
 * automat modalul Stripe când e nevoie).
 *
 * PaymentIntent-ul e cu capture_method=manual (audit food-go #7): după confirmare
 * statusul e `requires_capture` (hold), iar încasarea are loc când restaurantul
 * acceptă comanda. Serverul verifică hold-ul prin POST /api/local-orders/[id]/pay.
 */
import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

/** Statusuri după confirmPayment care înseamnă „plata e în regulă” pentru o comandă Food. */
const OK_STATUSES = new Set(["requires_capture", "succeeded", "processing"]);

function PayForm({
    amountCents,
    onSuccess,
    onCancel,
}: {
    amountCents: number;
    onSuccess: () => void;
    onCancel: () => void;
}) {
    const t = useTranslations("paymentsEatsPaymentModal");
    const fmt = useFormatPrice();
    const stripe = useStripe();
    const elements = useElements();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        setError("");
        const { error: err, paymentIntent } = await stripe.confirmPayment({
            elements,
            redirect: "if_required",
        });
        setBusy(false);
        if (err) {
            // Mesajul Stripe e deja localizat de Payment Element; fallback tradus.
            setError(err.message ?? t("failed"));
            return;
        }
        if (paymentIntent && OK_STATUSES.has(paymentIntent.status)) {
            onSuccess();
        } else {
            setError(t("notCompleted"));
        }
    };

    return (
        <form onSubmit={submit} className="space-y-4">
            <PaymentElement />
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
            <p className="text-xs text-muted">{t("holdNote")}</p>
            <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="secondary" size="lg" onClick={onCancel}>
                    {t("renunta")}
                </Button>
                <Button type="submit" size="lg" disabled={!stripe} loading={busy}>
                    {t("pay", { amount: fmt(amountCents) })}
                </Button>
            </div>
        </form>
    );
}

export default function EatsPaymentModal({
    clientSecret,
    amountCents,
    onSuccess,
    onCancel,
}: {
    clientSecret: string;
    amountCents: number;
    onSuccess: () => void;
    onCancel: () => void;
}) {
    const t = useTranslations("paymentsEatsPaymentModal");
    return (
        <div className="fixed inset-0 z-overlay grid place-items-end bg-overlay/50 sm:place-items-center">
            <div className="w-full max-w-md rounded-t-card bg-surface p-5 shadow-elev-1 sm:rounded-card">
                <h2 className="mb-4 text-lg font-black text-fg">{t("title")}</h2>
                <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "stripe" } }}>
                    <PayForm amountCents={amountCents} onSuccess={onSuccess} onCancel={onCancel} />
                </Elements>
            </div>
        </div>
    );
}
