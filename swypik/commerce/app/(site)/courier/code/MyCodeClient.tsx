"use client";

/**
 * „Codul meu" — ecranul de recrutare clienți al șoferului/curierului.
 * Codul personal + QR + share. Clienții noi cu codul: primele 3 curse −50%.
 * Șoferul: 5 RON la prima cursă a clientului + 2% din cursele lui 6 luni.
 */
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useTranslations } from "next-intl";
import { ArrowLeft, Copy, Check, Share2, Users, Wallet } from "lucide-react";
import Link from "next/link";

type CodeData = {
    code: string;
    share_url: string;
    stats: {
        total_referred: number;
        active_referred: number;
        total_earned_cents: number;
    };
    terms: { discount_pct: number; discounted_rides: number; first_ride_bonus_cents: number };
};

export default function MyCodeClient() {
    const t = useTranslations("courierCode");
    const [data, setData] = useState<CodeData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        fetch("/api/couriers/my-code")
            .then(async (r) => {
                if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "error");
                return r.json();
            })
            .then(setData)
            .catch((e: Error) => setError(e.message));
    }, []);

    useEffect(() => {
        if (data?.share_url && canvasRef.current) {
            QRCode.toCanvas(canvasRef.current, data.share_url, {
                width: 220,
                margin: 1,
                color: { dark: "#111111", light: "#FFFFFF" },
            }).catch(() => { });
        }
    }, [data]);

    const copy = async () => {
        if (!data) return;
        try {
            await navigator.clipboard.writeText(data.share_url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard indisponibil */
        }
    };

    const share = async () => {
        if (!data) return;
        if (navigator.share) {
            navigator
                .share({
                    title: "Swypik",
                    text: t("shareText", { rides: data.terms.discounted_rides, code: data.code }),
                    url: data.share_url,
                })
                .catch(() => { });
        } else {
            copy();
        }
    };

    return (
        <div className="mx-auto min-h-screen max-w-md bg-surface px-5 pb-16 pt-6 text-fg">
            <div className="mb-6 flex items-center gap-3">
                <Link href="/courier" className="rounded-full p-2 hover:bg-surface-2" aria-label={t("backAria")}>
                    <ArrowLeft size={20} />
                </Link>
                <h1 className="text-xl font-extrabold">{t("myCodeTitle")}</h1>
            </div>

            {error === "not_approved" && (
                <p className="rounded-2xl bg-warning-soft p-4 text-sm font-semibold text-warning">
                    {t("codeAfterApproval")}
                </p>
            )}
            {error && error !== "not_approved" && (
                <p className="rounded-2xl bg-danger-soft p-4 text-sm font-semibold text-danger">
                    {t("codeLoadError")}
                </p>
            )}

            {data && (
                <>
                    <div className="rounded-3xl border border-subtle p-6 text-center shadow-sm">
                        <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
                            {t("yourInviteCode")}
                        </p>
                        <p className="mt-2 font-mono text-4xl font-extrabold tracking-[0.3em]">{data.code}</p>
                        <div className="mt-5 flex justify-center">
                            <canvas ref={canvasRef} className="rounded-xl" />
                        </div>
                        <p className="mt-4 text-[13px] leading-relaxed text-muted">
                            {t("codeTermsNote", {
                                rides: data.terms.discounted_rides,
                                discountPct: data.terms.discount_pct,
                                bonus: (data.terms.first_ride_bonus_cents / 100).toFixed(0),
                            })}
                        </p>
                        <div className="mt-5 grid grid-cols-2 gap-3">
                            <button
                                onClick={copy}
                                className="flex items-center justify-center gap-2 rounded-2xl border border-strong px-4 py-3 text-sm font-bold"
                            >
                                {copied ? <Check size={16} /> : <Copy size={16} />}
                                {copied ? t("copied") : t("copyLink")}
                            </button>
                            <button
                                onClick={share}
                                className="flex items-center justify-center gap-2 rounded-2xl bg-fg px-4 py-3 text-sm font-bold text-fg-inverse"
                            >
                                <Share2 size={16} /> {t("sendBtn")}
                            </button>
                        </div>
                    </div>

                    <div className="mt-6 rounded-3xl border border-subtle p-5">
                        <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
                            <Users size={17} /> {t("myClients")}
                        </h2>
                        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                            <div>
                                <p className="text-2xl font-extrabold tabular-nums">{data.stats.total_referred}</p>
                                <p className="text-[12px] font-semibold text-muted">{t("totalReferred")}</p>
                            </div>
                            <div>
                                <p className="text-2xl font-extrabold tabular-nums">{data.stats.active_referred}</p>
                                <p className="text-[12px] font-semibold text-muted">{t("active")}</p>
                            </div>
                            <div>
                                <p className="text-2xl font-extrabold tabular-nums">
                                    {(data.stats.total_earned_cents / 100).toFixed(0)}
                                    <span className="text-sm font-bold"> {t("currencyLei")}</span>
                                </p>
                                <p className="text-[12px] font-semibold text-muted">{t("earned")}</p>
                            </div>
                        </div>
                        <Link
                            href="/courier/earnings"
                            className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-sm font-bold"
                        >
                            <Wallet size={16} /> {t("seeEarnings")}
                        </Link>
                    </div>
                </>
            )}
        </div>
    );
}
