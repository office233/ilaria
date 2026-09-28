"use client";

/**
 * Alegerea metodei de plată pentru o rezervare 'pending': cardul (hold,
 * principal) sau wallet-ul (secundar). Folosit în sheet-ul de rezervare și
 * pe pagina rezervării (dacă plata n-a fost finalizată).
 */
import { useState } from "react";
import { CreditCard, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { CardPaymentForm } from "./CardPaymentForm";
import { errorKey, useStaysFormat } from "./format";

type Props = { bookingId: string; totalCents: number; currency: string; onDone: () => void };

export function PaymentStep({ bookingId, totalCents, currency, onDone }: Props) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [busy, setBusy] = useState<"card" | "wallet" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const call = async (kind: "card" | "wallet") => {
        setBusy(kind);
        setError(null);
        try {
            const res = await fetch(`/api/stays/bookings/${bookingId}/${kind === "card" ? "create-intent" : "pay"}`, { method: "POST" });
            const j = (await res.json().catch(() => ({}))) as { error?: string; clientSecret?: string };
            if (!res.ok) throw new Error(j.error ?? "internal_error");
            if (kind === "card" && j.clientSecret) setClientSecret(j.clientSecret);
            if (kind === "wallet") onDone();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    if (clientSecret) {
        return <CardPaymentForm bookingId={bookingId} clientSecret={clientSecret} amountCents={totalCents} currency={currency} onDone={onDone} />;
    }
    return (
        <div className="space-y-3">
            <p className="flex justify-between text-base font-semibold text-fg">
                <span>{t("totalLabel")}</span>
                <span>{f.money(totalCents, currency)}</span>
            </p>
            {error ? (
                <p role="alert" className="text-sm font-medium text-danger">
                    {t(errorKey(error))}
                </p>
            ) : null}
            <Button block size="lg" loading={busy === "card"} disabled={busy !== null} onClick={() => void call("card")}>
                <CreditCard className="h-4 w-4" aria-hidden />
                {t("payByCard")}
            </Button>
            <Button block variant="secondary" loading={busy === "wallet"} disabled={busy !== null} onClick={() => void call("wallet")}>
                <Wallet className="h-4 w-4" aria-hidden />
                {t("payByWallet")}
            </Button>
            <p className="text-center text-xs text-muted">{t("holdExplainer")}</p>
        </div>
    );
}
