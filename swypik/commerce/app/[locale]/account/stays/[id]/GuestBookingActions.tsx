"use client";

/**
 * Acțiunile clientului pe rezervare: finalizarea plății (dacă e 'pending'),
 * anularea cu previzualizarea refundului (Dialog, nu confirm() nativ) și
 * recenzia după sejur.
 */
import { useState } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { errorKey, useStaysFormat } from "@/components/stays/format";
import { PaymentStep } from "@/components/stays/PaymentStep";
import { cn } from "@/lib/ui/cn";

type Props = {
    booking: { id: string; totalCents: number; currency: string };
    canPay: boolean;
    canCancel: boolean;
    refundPreview: { refundPct: number; refundCents: number };
    canReview: boolean;
    existingReview: { rating: number; comment: string | null } | null;
};

export default function GuestBookingActions({ booking, canPay, canCancel, refundPreview, canReview, existingReview }: Props) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    const router = useRouter();
    const { toast } = useToast();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [rating, setRating] = useState(0);
    const [comment, setComment] = useState("");

    const post = async (url: string, body?: unknown, success?: string) => {
        setBusy(true);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(j.error ?? "internal_error");
            if (success) toast({ title: success, tone: "success" });
            router.refresh();
            return true;
        } catch (e) {
            toast({ title: t(errorKey((e as Error).message)), tone: "danger" });
            return false;
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {canPay ? (
                <Card padding="md">
                    <h2 className="mb-3 text-base font-semibold text-fg">{t("completePayment")}</h2>
                    <PaymentStep bookingId={booking.id} totalCents={booking.totalCents} currency={booking.currency} onDone={() => router.refresh()} />
                </Card>
            ) : null}

            {canReview ? (
                <Card padding="md" className="space-y-3">
                    <h2 className="text-base font-semibold text-fg">{t("reviewTitle")}</h2>
                    <div className="flex gap-1" role="radiogroup" aria-label={t("ratingLabel")}>
                        {[1, 2, 3, 4, 5].map((n) => (
                            <button
                                key={n}
                                type="button"
                                role="radio"
                                aria-checked={rating === n}
                                aria-label={t("starsLabel", { count: n })}
                                onClick={() => setRating(n)}
                                className="flex h-11 w-11 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                                <Star className={cn("h-7 w-7", n <= rating ? "fill-current text-warning" : "text-subtle")} aria-hidden />
                            </button>
                        ))}
                    </div>
                    <Textarea value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder={t("reviewPlaceholder")} aria-label={t("reviewTitle")} />
                    <Button
                        block
                        loading={busy}
                        disabled={rating === 0}
                        onClick={() => void post(`/api/stays/bookings/${booking.id}/review`, { rating, comment: comment || undefined }, t("reviewThanks"))}
                    >
                        {t("reviewSubmit")}
                    </Button>
                </Card>
            ) : existingReview ? (
                <Card variant="muted" padding="md">
                    <p className="flex items-center gap-1 text-sm font-semibold text-fg">
                        <Star className="h-4 w-4 fill-current text-warning" aria-hidden />
                        {t("yourReview", { rating: existingReview.rating })}
                    </p>
                    {existingReview.comment ? <p className="mt-1 text-sm text-muted">{existingReview.comment}</p> : null}
                </Card>
            ) : null}

            {canCancel ? (
                <>
                    <Button block variant="secondary" onClick={() => setConfirmOpen(true)}>
                        {t("cancelBooking")}
                    </Button>
                    <Dialog
                        open={confirmOpen}
                        onOpenChange={setConfirmOpen}
                        title={t("cancelConfirmTitle")}
                        description={
                            refundPreview.refundCents > 0
                                ? t("cancelConfirmRefund", { amount: f.money(refundPreview.refundCents, booking.currency), pct: refundPreview.refundPct })
                                : t("cancelConfirmNoRefund")
                        }
                        footer={
                            <div className="flex gap-2">
                                <Button variant="secondary" className="flex-1" onClick={() => setConfirmOpen(false)}>
                                    {t("keepBooking")}
                                </Button>
                                <Button
                                    variant="danger"
                                    className="flex-1"
                                    loading={busy}
                                    onClick={async () => {
                                        if (await post(`/api/stays/bookings/${booking.id}/cancel`, undefined, t("cancelledToast"))) setConfirmOpen(false);
                                    }}
                                >
                                    {t("confirmCancel")}
                                </Button>
                            </div>
                        }
                    />
                </>
            ) : null}
        </>
    );
}
