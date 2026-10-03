"use client";

/**
 * Plata cu cardul a unei rezervări Stays (Stripe Payment Element, fără
 * redirect; 3DS se deschide automat). Hold-ul e doar AUTORIZAT — la
 * `requires_capture` anunțăm serverul (confirm-card), care verifică la Stripe.
 */
import { useState, type FormEvent } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { errorKey, useStaysFormat } from "./format";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "");

type Props = { bookingId: string; clientSecret: string; amountCents: number; currency: string; onDone: () => void };

function Form({ bookingId, amountCents, currency, onDone }: Omit<Props, "clientSecret">) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
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
        if (err || !paymentIntent || !["requires_capture", "succeeded", "processing"].includes(paymentIntent.status)) {
            setBusy(false);
            setError(err?.message ?? t("errors.payment_not_authorized"));
            return;
        }
        const res = await fetch(`/api/stays/bookings/${bookingId}/confirm-card`, { method: "POST" });
        setBusy(false);
        if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            setError(t(errorKey(j.error)));
            return;
        }
        onDone();
    };

    return (
        <form onSubmit={submit} className="space-y-4">
            <PaymentElement />
            {error ? (
                <p role="alert" className="text-sm font-medium text-danger">
                    {error}
                </p>
            ) : null}
            <Button type="submit" block size="lg" loading={busy} disabled={!stripe}>
                <Lock className="h-4 w-4" aria-hidden />
                {t("authorizeAmount", { amount: f.money(amountCents, currency) })}
            </Button>
            <p className="text-center text-xs text-muted">{t("holdExplainer")}</p>
        </form>
    );
}

export function CardPaymentForm({ clientSecret, ...rest }: Props) {
    return (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "stripe" } }}>
            <Form {...rest} />
        </Elements>
    );
}
