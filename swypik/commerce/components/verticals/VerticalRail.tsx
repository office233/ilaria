"use client";

import { Sparkles } from "lucide-react";

/**
 * VerticalRail — bara orizontală de verticale, sub header.
 *
 * Nu e „search”: user-ul nu trebuie să știe ce vrea. Feed-ul îi propune, iar
 * bara asta e doar scurtătura pentru cine vrea să navigheze intenționat.
 * Ordinea vine de la server (ponderată pe ora zilei), cu fallback local.
 */
import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { haptic } from "@/lib/haptic";
import { liveVerticals } from "@/lib/verticals/catalog";

export interface RailItem {
    id: string;
    emoji: string;
    labelKey: string;
    accent: string;
}

interface Props {
    items?: RailItem[];
    activeId?: string | null;
    onSelect?: (id: string | null) => void;
    className?: string;
}

export default function VerticalRail({ items, activeId = null, onSelect, className = "" }: Props) {
    const t = useTranslations("verticals");

    const rail: RailItem[] =
        items ??
        liveVerticals(1).map((v) => ({
            id: v.id,
            emoji: v.emoji,
            labelKey: v.labelKey,
            accent: v.accent,
        }));

    const handle = useCallback(
        (id: string | null) => {
            haptic("tap");
            onSelect?.(id);
        },
        [onSelect],
    );

    return (
        <nav
            aria-label={t("railLabel")}
            className={`flex gap-2 overflow-x-auto scrollbar-none px-4 py-2.5 snap-x ${className}`}
        >
            {/* „Tot” — mixul algoritmic, starea implicită */}
            <button
                type="button"
                onClick={() => handle(null)}
                aria-pressed={activeId === null}
                className={`shrink-0 snap-start inline-flex items-center gap-1.5 rounded-full px-4 h-9 text-sm font-bold transition active:scale-95 ${activeId === null
                        ? "bg-[#0D0D0D] text-white"
                        : "bg-[#F7F7F8] text-[#6E6E80] hover:bg-[#EFEFF1]"
                    }`}
            >
                <span aria-hidden><Sparkles size={14} className="inline" /></span>
                {t("all")}
            </button>

            {rail.map((v) => {
                const active = activeId === v.id;
                return (
                    <button
                        key={v.id}
                        type="button"
                        onClick={() => handle(v.id)}
                        aria-pressed={active}
                        style={active ? { backgroundColor: v.accent, color: "#fff" } : undefined}
                        className={`shrink-0 snap-start inline-flex items-center gap-1.5 rounded-full px-4 h-9 text-sm font-bold transition active:scale-95 ${active ? "" : "bg-[#F7F7F8] text-[#6E6E80] hover:bg-[#EFEFF1]"
                            }`}
                    >
                        <span aria-hidden>{v.emoji}</span>
                        {t(`${v.labelKey}.label`)}
                    </button>
                );
            })}
        </nav>
    );
}
