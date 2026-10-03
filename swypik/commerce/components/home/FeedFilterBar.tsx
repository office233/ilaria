"use client";

/**
 * FeedFilterBar — sortare + filtre pentru feed-ul de pe home.
 * Pill-uri sticky + bottom-sheet cu preț / discount / rating.
 */
import { useState } from "react";
import { SlidersHorizontal, Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/Dialog";
import { haptic } from "@/lib/haptic";
import type { OffersSort } from "@/lib/types/feed";

export type FeedFilters = {
    sort: OffersSort;
    minPrice?: number;
    maxPrice?: number;
    minDiscount?: number;
    minRating?: number;
};

type Props = {
    filters: FeedFilters;
    onChange: (next: FeedFilters) => void;
};

const SORTS: OffersSort[] = ["popular", "new", "discount"];
const DISCOUNTS = [10, 30, 50, 70];
const RATINGS = [3, 4, 4.5];

export default function FeedFilterBar({ filters, onChange }: Props) {
    const t = useTranslations("homeFeed");
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<FeedFilters>(filters);

    const activeExtras =
        (filters.minPrice != null || filters.maxPrice != null ? 1 : 0) +
        (filters.minDiscount ? 1 : 0) +
        (filters.minRating ? 1 : 0);

    function apply() {
        haptic("tap");
        onChange(draft);
        setOpen(false);
    }

    function reset() {
        const next: FeedFilters = { sort: filters.sort };
        setDraft(next);
        onChange(next);
        setOpen(false);
    }

    return (
        <>
            <div className="sticky top-0 z-20 -mx-1 flex items-center gap-2 overflow-x-auto bg-[#FAFAFB]/90 dark:bg-black/90 px-1 py-2 backdrop-blur-sm [scrollbar-width:none]">
                {SORTS.map((s) => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => { haptic("tap"); onChange({ ...filters, sort: s }); }}
                        className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-bold transition ${filters.sort === s
                            ? "bg-[#0D0D0D] text-white dark:bg-white dark:text-black"
                            : "bg-white text-[#6E6E80] ring-1 ring-black/10 hover:bg-[#F0F0F2] dark:bg-[#111113] dark:text-[#A1A1AA] dark:ring-white/10 dark:hover:bg-[#1F1F23]"
                            }`}
                    >
                        {t(`sort.${s}`)}
                    </button>
                ))}
                <Dialog
                    open={open}
                    onOpenChange={(nextOpen) => {
                        if (nextOpen) setDraft(filters);
                        setOpen(nextOpen);
                    }}
                    title={t("filters")}
                    className="top-auto bottom-0 w-full translate-y-0 rounded-b-none rounded-t-3xl bg-white dark:bg-[#111113] pb-8 lg:bottom-auto lg:top-1/2 lg:-translate-y-1/2 lg:rounded-3xl"
                    trigger={
                        <button
                            type="button"
                            className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-bold ring-1 transition ${activeExtras
                                ? "bg-violet-600 text-white ring-violet-600"
                                : "bg-white text-[#6E6E80] ring-black/10 hover:bg-[#F0F0F2] dark:bg-[#111113] dark:text-[#A1A1AA] dark:ring-white/10 dark:hover:bg-[#1F1F23]"
                                }`}
                        >
                            <SlidersHorizontal size={14} />
                            {t("filters")}{activeExtras ? ` · ${activeExtras}` : ""}
                        </button>
                    }
                >
                    <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-[#A1A1AA]">{t("price")}</p>
                    <div className="mb-4 flex items-center gap-2">
                        <input
                            type="number" min={0} inputMode="numeric"
                            placeholder={t("min")}
                            aria-label={`${t("price")} — ${t("min")}`}
                            value={draft.minPrice ?? ""}
                            onChange={(e) => setDraft({ ...draft, minPrice: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-full rounded-xl border border-black/10 dark:border-white/10 dark:bg-[#1F1F23] dark:text-white px-3 py-2 text-[14px] font-semibold outline-none focus:border-violet-500"
                        />
                        <span className="text-[#A1A1AA]">—</span>
                        <input
                            type="number" min={0} inputMode="numeric"
                            placeholder={t("max")}
                            aria-label={`${t("price")} — ${t("max")}`}
                            value={draft.maxPrice ?? ""}
                            onChange={(e) => setDraft({ ...draft, maxPrice: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-full rounded-xl border border-black/10 dark:border-white/10 dark:bg-[#1F1F23] dark:text-white px-3 py-2 text-[14px] font-semibold outline-none focus:border-violet-500"
                        />
                    </div>

                    <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-[#A1A1AA]">{t("minDiscount")}</p>
                    <div className="mb-4 flex gap-2">
                        {DISCOUNTS.map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => setDraft({ ...draft, minDiscount: draft.minDiscount === d ? undefined : d })}
                                className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold transition ${draft.minDiscount === d ? "bg-red-500 text-white" : "bg-[#F0F0F2] text-[#6E6E80] dark:bg-[#1F1F23] dark:text-[#A1A1AA]"}`}
                            >
                                -{d}%
                            </button>
                        ))}
                    </div>

                    <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-[#A1A1AA]">{t("minRating")}</p>
                    <div className="mb-6 flex gap-2">
                        {RATINGS.map((r) => (
                            <button
                                key={r}
                                type="button"
                                onClick={() => setDraft({ ...draft, minRating: draft.minRating === r ? undefined : r })}
                                className={`rounded-full px-3.5 py-1.5 text-[12px] font-bold transition ${draft.minRating === r ? "bg-amber-400 text-white" : "bg-[#F0F0F2] text-[#6E6E80] dark:bg-[#1F1F23] dark:text-[#A1A1AA]"}`}
                            >
                                <Star size={12} className="inline" fill="currentColor" /> {r}+
                            </button>
                        ))}
                    </div>

                    <div className="flex gap-3">
                        <button type="button" onClick={reset} className="flex-1 rounded-2xl bg-[#F0F0F2] dark:bg-[#1F1F23] py-3 text-[14px] font-bold text-[#6E6E80] dark:text-[#A1A1AA]">
                            {t("reset")}
                        </button>
                        <button type="button" onClick={apply} className="flex-[2] rounded-2xl bg-[#0D0D0D] dark:bg-white py-3 text-[14px] font-extrabold text-white dark:text-black">
                            {t("apply")}
                        </button>
                    </div>
                </Dialog>
            </div>
        </>
    );
}
