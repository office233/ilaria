"use client";

/**
 * FRONT R5 — ecranul de câștiguri al curierului (/courier/earnings).
 *
 * Azi / săptămână / lună, lista livrărilor & curselor cu suma per fiecare
 * (din wallet_ledger_entries), soldul disponibil, cerere de retragere și onboarding
 * Stripe Connect pentru payout automat.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import Link from "next/link";

/** Codurile stabile ale API-urilor de câștiguri/plăți → courierEarnings.errors.<cod>. */
const ERROR_CODES = new Set(["unauthorized", "not_a_courier", "not_approved", "below_min_payout", "invalid_iban", "payout_pending", "rate_limited"]);

type Bucket = { eats_cents: number; go_cents: number; tips_cents: number; net_cents: number };
type Entry = {
    id: string;
    kind: "credit" | "debit";
    amount_cents: number;
    ref_type: string;
    ref_id: string;
    description: string | null;
    created_at: string;
    tip_cents: number | null;
};
type Payout = {
    id: string;
    amount_cents: number;
    status: string;
    requested_at: string;
    resolved_at: string | null;
};
type EarningsData = {
    balance_cents: number;
    periods: Record<"today" | "week" | "month", Bucket>;
    entries: Entry[];
    payouts: Payout[];
    currency: string;
    min_payout_cents?: number;
};
type ConnectStatus = { connected: boolean; payouts_enabled: boolean; details_submitted?: boolean };

export default function EarningsClient() {
    const t = useTranslations("courierEarnings");
    const locale = useLocale();
    const fmt = useCallback(
        (cents: number, currency: string) => {
            try {
                return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
            } catch {
                return `${(cents / 100).toLocaleString(locale)} ${currency}`;
            }
        },
        [locale],
    );
    const REF_LABEL: Record<string, string> = {
        ride: t("refRide"),
        order: t("refOrder"),
        payout: t("refPayout"),
        payout_refund: t("refPayoutRefund"),
    };
    const STATUS_LABEL: Record<string, string> = {
        pending: t("statusPending"),
        processing: t("statusProcessing"),
        paid: t("statusPaid"),
        failed: t("statusFailed"),
        rejected: t("statusRejected"),
    };
    const [data, setData] = useState<EarningsData | null>(null);
    const [connect, setConnect] = useState<ConnectStatus | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState("");
    const [msg, setMsg] = useState("");
    const errorText = useCallback(
        (j: { code?: unknown; error?: unknown } | null, fallback: string) => {
            const code = typeof j?.code === "string" ? j.code : typeof j?.error === "string" ? j.error : "";
            return ERROR_CODES.has(code) ? t(`errors.${code}`) : fallback;
        },
        [t],
    );

    const load = useCallback(async () => {
        try {
            const [eRes, cRes] = await Promise.all([
                fetch("/api/couriers/earnings"),
                fetch("/api/couriers/connect"),
            ]);
            if (!eRes.ok) {
                const j = await eRes.json().catch(() => null);
                setError(errorText(j, t("loadDataError")));
                return;
            }
            setData(await eRes.json());
            if (cRes.ok) setConnect(await cRes.json());
        } catch {
            setError(t("networkError"));
        }
    }, [t, errorText]);

    useEffect(() => {
        void load();
    }, [load]);

    const requestPayout = async () => {
        setMsg("");
        setError("");
        const cents = Math.round(Number(amount.replace(",", ".")) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
            setError(t("invalidAmount"));
            return;
        }
        setBusy(true);
        try {
            const res = await fetch("/api/couriers/payouts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ amount_cents: cents }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok) {
                setError(errorText(j, t("payoutRequestFailed")));
            } else {
                setMsg(t("payoutRequestRegistered"));
                setAmount("");
                await load();
            }
        } finally {
            setBusy(false);
        }
    };

    const startOnboarding = async () => {
        setBusy(true);
        setError("");
        try {
            const res = await fetch("/api/couriers/connect", { method: "POST" });
            const j = await res.json().catch(() => null);
            if (res.ok && j?.url) window.location.href = j.url;
            else setError(errorText(j, t("onboardingUnavailable")));
        } finally {
            setBusy(false);
        }
    };

    if (error && !data) {
        return <main className="mx-auto max-w-md p-6 text-danger">{error}</main>;
    }
    if (!data) {
        return <main className="mx-auto max-w-md p-6 text-muted">{t("loading")}</main>;
    }

    const negative = data.balance_cents < 0;
    const minPayout = data.min_payout_cents ?? 0;

    return (
        <main className="mx-auto max-w-md space-y-6 p-4 pb-24">
            <header className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-fg">{t("title")}</h1>
                <Link href="/courier" className="text-sm text-brand underline">
                    ← {t("courierPwaLink")}
                </Link>
            </header>

            {/* Sold */}
            <section className="rounded-card bg-surface-2 p-5 text-fg">
                <p className="text-sm text-muted">{t("availableBalance")}</p>
                <p className={`text-3xl font-bold ${negative ? "text-danger" : ""}`}>
                    {fmt(data.balance_cents, data.currency)}
                </p>
                {negative && (
                    <p className="mt-1 text-xs text-danger">
                        {t("negativeBalanceNote")}
                    </p>
                )}
            </section>

            {/* Perioade */}
            <section className="grid grid-cols-3 gap-2">
                {(["today", "week", "month"] as const).map((p) => (
                    <div key={p} className="rounded-card border border-subtle p-3 text-center">
                        <p className="text-xs text-muted">
                            {p === "today" ? t("periodToday") : p === "week" ? t("periodWeek") : t("periodMonth")}
                        </p>
                        <p className="font-semibold text-fg">{fmt(data.periods[p]?.net_cents ?? 0, data.currency)}</p>
                        <p className="text-[10px] text-subtle">
                            Eats {fmt(data.periods[p]?.eats_cents ?? 0, data.currency)} · Go {fmt(data.periods[p]?.go_cents ?? 0, data.currency)}
                        </p>
                    </div>
                ))}
            </section>

            {/* Stripe Connect */}
            <section className="rounded-card border border-subtle p-4">
                <h2 className="mb-2 font-semibold text-fg">{t("autoPayTitle")}</h2>
                {connect?.payouts_enabled ? (
                    <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 size={16} aria-hidden /> {t("stripeActive")}</p>
                ) : connect?.connected ? (
                    <div className="space-y-2">
                        <p className="text-sm text-warning">{t("stripeIncomplete")}</p>
                        <Button size="sm" onClick={startOnboarding} disabled={busy}>
                            {t("continueVerification")}
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        <p className="text-sm text-muted">
                            {t("connectStripeNote")}
                        </p>
                        <Button size="sm" onClick={startOnboarding} disabled={busy}>
                            {t("configurePayments")}
                        </Button>
                    </div>
                )}
            </section>

            {/* Retragere */}
            <section className="rounded-card border border-subtle p-4">
                <h2 className="mb-2 font-semibold text-fg">{t("withdrawal")}</h2>
                <div className="flex gap-2">
                    <Input
                        type="text"
                        inputMode="decimal"
                        aria-label={t("withdrawal")}
                        placeholder={t("amountMinPlaceholder", { min: fmt(minPayout, data.currency) })}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="flex-1"
                    />
                    <Button onClick={requestPayout} disabled={busy || data.balance_cents < minPayout}>
                        {t("withdrawBtn")}
                    </Button>
                </div>
                {msg && <p className="mt-2 text-sm text-success">{msg}</p>}
                {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
                {data.payouts.length > 0 && (
                    <ul className="mt-3 space-y-1 text-sm">
                        {data.payouts.map((p) => (
                            <li key={p.id} className="flex justify-between border-t border-subtle pt-1 text-fg">
                                <span>{new Date(p.requested_at).toLocaleDateString(locale)}</span>
                                <span>{fmt(p.amount_cents, data.currency)}</span>
                                <span className="text-muted">{STATUS_LABEL[p.status] ?? p.status}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* Istoric livrări & curse */}
            <section className="rounded-card border border-subtle p-4">
                <h2 className="mb-2 font-semibold text-fg">{t("lastTransactions")}</h2>
                {data.entries.length === 0 ? (
                    <p className="text-sm text-muted">{t("emptyTransactions")}</p>
                ) : (
                    <ul className="space-y-1 text-sm">
                        {data.entries.map((e) => (
                            <li key={e.id} className="flex items-center justify-between border-t border-subtle py-1 text-fg">
                                <div>
                                    <p>{REF_LABEL[e.ref_type] ?? e.ref_type} <span className="text-subtle">#{e.ref_id.slice(0, 8)}</span></p>
                                    <p className="text-[10px] text-subtle">
                                        {new Date(e.created_at).toLocaleString(locale)}
                                        {e.tip_cents ? ` · ${t("tipLabel")} ${fmt(Number(e.tip_cents), data.currency)}` : ""}
                                    </p>
                                </div>
                                <span className={e.kind === "credit" ? "font-medium text-success" : "font-medium text-danger"}>
                                    {e.kind === "credit" ? "+" : "−"}{fmt(e.amount_cents, data.currency)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </main>
    );
}
