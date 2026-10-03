"use client";

/**
 * Pagina unei cazări: galerie, detalii, facilități, reguli, politica de
 * anulare (vizibilă ÎNAINTE de plată), recenzii și bara fixă de rezervare.
 */
import { useState } from "react";
import { Check, ShieldCheck, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { useStaysFormat } from "@/components/stays/format";
import { StayBookingSheet } from "@/components/stays/StayBookingSheet";
import { StayGallery } from "@/components/stays/StayGallery";
import type { StayDetail } from "@/lib/stays/listing-detail";
import type { Range } from "@/lib/stays/range-select";
import type { StayReview } from "@/lib/stays/reviews";

type Props = {
    stay: StayDetail;
    reviews: { reviews: StayReview[]; average: number | null; count: number };
    policy: {
        freeCancelDays: number;
        lateRefundPct: number;
        hostResponseHours: number;
        pendingMinutes: number;
        maxNights: number;
        maxGuests: number;
    };
    initial: { range: Range; guests: number };
};

export default function StayDetailClient({ stay, reviews, policy, initial }: Props) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    const [open, setOpen] = useState(false);

    return (
        <div className="min-h-dvh bg-canvas">
            <PageHeader back="/stays" title={stay.title} />
            <StayGallery images={stay.images} title={stay.title} />
            <main className="mx-auto max-w-lg space-y-5 px-gutter py-4 pb-28">
                <section>
                    <h1 className="text-xl font-bold text-fg">{stay.title}</h1>
                    <p className="mt-1 text-sm text-muted">
                        {[stay.city, stay.maxGuests ? t("upToGuests", { count: stay.maxGuests }) : null].filter(Boolean).join(" · ")}
                    </p>
                    {reviews.average !== null ? (
                        <p className="mt-1 flex items-center gap-1 text-sm text-fg">
                            <Star className="h-4 w-4 fill-current text-warning" aria-hidden />
                            {reviews.average.toFixed(1)} <span className="text-muted">· {t("reviewsCount", { count: reviews.count })}</span>
                        </p>
                    ) : null}
                </section>

                <Card padding="md" className="flex items-center gap-3">
                    <Avatar src={stay.hostAvatar} name={stay.hostName ?? t("hostFallbackName")} size="md" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-fg">{t("hostedBy", { name: stay.hostName ?? t("hostFallbackName") })}</p>
                        <p className="flex items-center gap-1 text-xs text-muted">
                            <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
                            {t("verifiedHost")}
                        </p>
                    </div>
                </Card>

                {stay.description ? <p className="whitespace-pre-line text-base text-fg">{stay.description}</p> : null}

                {stay.amenities.length ? (
                    <section>
                        <h2 className="mb-2 text-base font-semibold text-fg">{t("amenitiesTitle")}</h2>
                        <ul className="grid grid-cols-2 gap-2">
                            {stay.amenities.map((a) => (
                                <li key={a} className="flex items-center gap-2 text-sm text-fg">
                                    <Check className="h-4 w-4 text-success" aria-hidden />
                                    {t(`amenity.${a}`)}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}

                {stay.houseRules ? (
                    <section>
                        <h2 className="mb-1 text-base font-semibold text-fg">{t("houseRulesTitle")}</h2>
                        <p className="whitespace-pre-line text-sm text-muted">{stay.houseRules}</p>
                    </section>
                ) : null}

                <Card variant="muted" padding="md">
                    <h2 className="mb-1 text-base font-semibold text-fg">{t("cancellationTitle")}</h2>
                    <p className="text-sm text-muted">
                        {t("cancellationPolicy", { days: policy.freeCancelDays, pct: policy.lateRefundPct })}
                    </p>
                    <p className="mt-2 text-sm text-muted">{t("requestExplainer", { hours: policy.hostResponseHours })}</p>
                </Card>

                <section>
                    <h2 className="mb-2 text-base font-semibold text-fg">{t("reviewsTitle")}</h2>
                    {reviews.reviews.length === 0 ? (
                        <p className="text-sm text-muted">{t("noReviews")}</p>
                    ) : (
                        <ul className="space-y-3">
                            {reviews.reviews.map((r) => (
                                <li key={r.id} className="rounded-card border border-subtle bg-surface p-3">
                                    <p className="flex items-center gap-1 text-sm font-semibold text-fg">
                                        <Star className="h-4 w-4 fill-current text-warning" aria-hidden />
                                        {r.rating} · {r.author ?? t("guestFallbackName")}
                                    </p>
                                    {r.comment ? <p className="mt-1 text-sm text-fg">{r.comment}</p> : null}
                                    {r.host_reply ? <p className="mt-2 border-l-2 border-subtle pl-2 text-sm text-muted">{r.host_reply}</p> : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </main>

            <div
                className="fixed inset-x-0 z-header border-t border-subtle bg-elevated/95 px-gutter py-3 backdrop-blur"
                style={{ bottom: "var(--bottom-inset)" }}
            >
                <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
                    <div>
                        <p className="text-lg font-bold text-fg">{f.money(stay.pricePerNightCents, stay.currency)}</p>
                        <p className="text-xs text-muted">{t("perNight")}</p>
                    </div>
                    <Button size="lg" onClick={() => setOpen(true)}>
                        {t("checkAvailability")}
                    </Button>
                </div>
            </div>

            <StayBookingSheet
                open={open}
                onOpenChange={setOpen}
                stayId={stay.id}
                initial={initial}
                limits={{ maxNights: policy.maxNights, maxGuests: policy.maxGuests, hostResponseHours: policy.hostResponseHours }}
            />
        </div>
    );
}
