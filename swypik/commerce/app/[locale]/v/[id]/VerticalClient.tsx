"use client";

/**
 * Pagina unei verticale — feed filtrat, cu acțiunea contextuală a modului
 * de tranzacție (cart / order / booking / lead / ride).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { useRouter } from "@/lib/i18n/navigation";
import { verticalItemHref } from "./item-href";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { ArrowLeft, Check, MapPin } from "lucide-react";
import VerticalRail from "@/components/verticals/VerticalRail";
import { ACTION_KEY, type Vertical } from "@/lib/verticals/catalog";

interface FeedItem {
    video: {
        id: string;
        slug: string | null;
        title: string;
        thumbnail_url: string | null;
        playback_url: string | null;
        likes: number;
        comments: number;
    };
    publisher: { id: string; name: string | null; avatar: string | null; verified: boolean };
    entity: {
        id: string;
        slug: string | null;
        title: string;
        price_cents: number | null;
        currency: string;
        listing_type: string;
        image: string | null;
        city: string | null;
    } | null;
    vertical: { id: string; emoji: string; accent: string; mode: string; actionKey: string };
}

/** Verticale cu pagină proprie (flux complet), în loc de feed generic. */
const DEDICATED_PAGES: Record<string, string> = {
    eats: "/food",
    go: "/go",
    fly: "/fly",
    stays: "/stays",
};

export default function VerticalClient({ vertical }: { vertical: Vertical }) {
  const tx = useTranslations("vertical");
    const t = useTranslations("verticals");
    const router = useRouter();
    const nextRouter = useNextRouter(); // doar pentru /seller (rută non-localizată)
    const [items, setItems] = useState<FeedItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [city, setCity] = useState<string | null>(null);
    const [sub, setSub] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const qs = new URLSearchParams({ vertical: vertical.id, limit: "12" });
            if (sub) qs.set("sub", sub);
            if (city) qs.set("city", city);
            const res = await fetch(`/api/feed/universal?${qs}`);
            const data = await res.json();
            if (data.success) setItems(data.items ?? []);
        } finally {
            setLoading(false);
        }
    }, [vertical.id, city, sub]);

    useEffect(() => {
        const dedicated = DEDICATED_PAGES[vertical.id];
        if (dedicated) {
            router.replace(dedicated);
            return;
        }
        void load();
    }, [load, vertical.id, router]);

    // Verticalele locale au nevoie de oraș ca să aibă sens.
    useEffect(() => {
        if (!vertical.localOnly) return;
        const saved = localStorage.getItem("swypik_city");
        if (saved) setCity(saved);
    }, [vertical.localOnly]);

    const actionLabel = t(ACTION_KEY[vertical.mode].replace("actions.", "actions.") as never);

    return (
        <div className="min-h-dvh bg-white dark:bg-black pb-24">
            {/* Header cu identitatea verticalei */}
            <header
                className="sticky top-0 z-30 border-b border-black/5 dark:border-[#1F1F1F] backdrop-blur-xl"
                style={{ backgroundColor: `${vertical.accent}0D` }}
            >
                <div className="flex items-center gap-3 px-4 h-14">
                    <button
                        type="button"
                        onClick={() => router.back()}
                        aria-label={t("back" as never)}
                        className="grid h-9 w-9 place-items-center rounded-full bg-white/80 dark:bg-black/80 dark:text-white active:scale-95 transition"
                    >
                        <ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xl" aria-hidden>{vertical.emoji}</span>
                        <div className="min-w-0">
                            <h1 className="text-base font-black leading-tight truncate dark:text-white">
                                {t(`${vertical.labelKey}.label`)}
                            </h1>
                            <p className="text-[11px] text-[#6E6E80] dark:text-[#A1A1AA] leading-tight">{vertical.brand}</p>
                        </div>
                    </div>
                    {vertical.localOnly && (
                        <button
                            type="button"
                            onClick={() => {
                                const c = prompt(tx("cityPrompt"), city ?? "");
                                if (c) {
                                    localStorage.setItem("swypik_city", c);
                                    setCity(c);
                                }
                            }}
                            className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-black/80 dark:text-white px-3 h-8 text-xs font-bold active:scale-95 transition"
                        >
                            <MapPin className="h-3.5 w-3.5" />
                            {city ?? tx("chooseCity")}
                        </button>
                    )}
                </div>
                <VerticalRail
                    activeId={vertical.id}
                    onSelect={(id) => router.push(id ? `/v/${id}` : "/")}
                />
                {/* Subcategoriile verticalei — chip-uri în culoarea verticalei */}
                {vertical.subcategories && vertical.subcategories.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto scrollbar-none px-4 pb-2.5 snap-x">
                        <button
                            type="button"
                            onClick={() => setSub(null)}
                            aria-pressed={sub === null}
                            style={sub === null ? { backgroundColor: vertical.accent } : undefined}
                            className={`shrink-0 snap-start rounded-full px-3.5 h-8 text-xs font-bold transition active:scale-95 ${sub === null ? "text-white" : "bg-white/80 dark:bg-black/80 text-[#6E6E80] dark:text-[#A1A1AA]"
                                }`}
                        >
                            {t("all")}
                        </button>
                        {vertical.subcategories.map((s) => {
                            const active = sub === s.slug;
                            return (
                                <button
                                    key={s.slug}
                                    type="button"
                                    onClick={() => setSub(active ? null : s.slug)}
                                    aria-pressed={active}
                                    style={active ? { backgroundColor: vertical.accent } : undefined}
                                    className={`shrink-0 snap-start inline-flex items-center gap-1 rounded-full px-3.5 h-8 text-xs font-bold transition active:scale-95 ${active ? "text-white" : "bg-white/80 dark:bg-black/80 text-[#6E6E80] dark:text-[#A1A1AA]"
                                        }`}
                                >
                                    <span aria-hidden>{s.emoji}</span>
                                    {t(`${s.labelKey}` as never)}
                                </button>
                            );
                        })}
                    </div>
                )}
            </header>

            {/* Feed */}
            <main className="px-4 pt-4">
                {loading ? (
                    <div className="grid grid-cols-2 gap-3">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="aspect-[3/4] rounded-2xl bg-[#F7F7F8] dark:bg-[#1F1F23] animate-pulse" />
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <div className="py-20 text-center">
                        <div className="text-5xl mb-3" aria-hidden>{vertical.emoji}</div>
                        <p className="font-bold text-[#0D0D0D] dark:text-white">{t("emptyTitle" as never)}</p>
                        <p className="text-sm text-[#6E6E80] dark:text-[#A1A1AA] mt-1 max-w-xs mx-auto">
                            
                            {tx("fiiPrimulCarePublica")} {t(`${vertical.labelKey}.label`)}.
                        </p>
                        <button
                            type="button"
                            onClick={() => nextRouter.push("/seller")}
                            style={{ backgroundColor: vertical.accent }}
                            className="mt-5 rounded-xl px-5 h-11 text-sm font-bold text-white active:scale-95 transition"
                        >
                            
                            {tx("publicaAcum")}
                        </button>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-3">
                        {items.map((it) => (
                            <article
                                key={it.video.id}
                                className="group overflow-hidden rounded-2xl border border-[#E5E5E5] dark:border-[#1F1F1F] bg-white dark:bg-[#111113]"
                            >
                                <div className="relative aspect-[3/4] bg-[#F7F7F8] dark:bg-[#1F1F23]">
                                    {it.video.thumbnail_url || it.entity?.image ? (
                                        <Image
                                            src={(it.video.thumbnail_url || it.entity?.image) as string}
                                            alt={it.entity?.title ?? it.video.title}
                                            fill
                                            sizes="(max-width: 768px) 50vw, 240px"
                                            className="object-cover"
                                        />
                                    ) : (
                                        <div className="absolute inset-0 grid place-items-center text-3xl">
                                            {vertical.emoji}
                                        </div>
                                    )}
                                    <span
                                        className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-black text-white"
                                        style={{ backgroundColor: vertical.accent }}
                                    >
                                        {vertical.emoji}
                                    </span>
                                </div>
                                <div className="p-3">
                                    <h2 className="text-sm font-bold leading-snug line-clamp-2 dark:text-white">
                                        {it.entity?.title ?? it.video.title}
                                    </h2>
                                    {it.publisher.name && (
                                        <p className="mt-1 text-[11px] text-[#6E6E80] dark:text-[#A1A1AA] truncate">
                                            {it.publisher.name}
                                            {it.publisher.verified && <Check size={12} className="ml-1 inline" />}
                                        </p>
                                    )}
                                    <div className="mt-2 flex items-center justify-between gap-2">
                                        <span className="text-sm font-black dark:text-white">
                                            {it.entity?.price_cents != null
                                                ? `${(it.entity.price_cents / 100).toLocaleString()} ${it.entity.currency}`
                                                : tx("onRequest")}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            router.push(verticalItemHref(it))
                                        }
                                        style={{ backgroundColor: vertical.accent }}
                                        className="mt-2 w-full rounded-xl h-10 text-xs font-bold text-white active:scale-95 transition"
                                    >
                                        {actionLabel}
                                    </button>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}
