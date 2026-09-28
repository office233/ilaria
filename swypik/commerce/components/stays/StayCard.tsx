"use client";

import { BedDouble, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import type { StayResult } from "@/lib/stays/search";
import { useStaysFormat } from "./format";

/** Cardul unei cazări în rezultate (imagine 16:10, preț/noapte, notă). */
export function StayCard({ stay, query }: { stay: StayResult; query?: string }) {
    const t = useTranslations("staysUi");
    const f = useStaysFormat();
    return (
        <Link
            href={`/stays/${stay.id}${query ? `?${query}` : ""}`}
            className="block overflow-hidden rounded-card border border-subtle bg-surface shadow-elev-1 transition-transform duration-fast active:scale-[0.99]"
        >
            <div className="relative aspect-[16/10] w-full bg-surface-2">
                {stay.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={stay.image} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                    <BedDouble className="absolute inset-0 m-auto h-10 w-10 text-subtle" aria-hidden />
                )}
            </div>
            <div className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-fg">{stay.title}</h3>
                    <p className="truncate text-sm text-muted">
                        {[stay.city, stay.maxGuests ? t("upToGuests", { count: stay.maxGuests }) : null].filter(Boolean).join(" · ")}
                    </p>
                    {stay.rating !== null ? (
                        <p className="mt-0.5 flex items-center gap-1 text-sm text-fg">
                            <Star className="h-4 w-4 fill-current text-warning" aria-hidden />
                            {stay.rating.toFixed(1)}
                            <span className="text-muted">({stay.reviewsCount})</span>
                        </p>
                    ) : (
                        <p className="mt-0.5 text-sm text-muted">{t("newListing")}</p>
                    )}
                </div>
                <div className="shrink-0 text-right">
                    <p className="text-base font-bold text-fg">{f.money(stay.pricePerNightCents, stay.currency)}</p>
                    <p className="text-xs text-muted">{t("perNight")}</p>
                </div>
            </div>
        </Link>
    );
}
