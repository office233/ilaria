"use client";

import { useEffect, useState } from "react";
import type { Range } from "@/lib/stays/range-select";

export type QuoteView = {
    available: boolean;
    reason: string | null;
    nights: number;
    totalCents: number;
    currency: string;
};

/** Preț + disponibilitate pentru intervalul ales (debounce scurt, ultimul răspuns câștigă). */
export function useStayQuote(stayId: string, range: Range, guests: number): { data: QuoteView | null; loading: boolean } {
    const [data, setData] = useState<QuoteView | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!range.checkIn || !range.checkOut) {
            setData(null);
            return;
        }
        let alive = true;
        setLoading(true);
        const q = new URLSearchParams({ productId: stayId, checkIn: range.checkIn, checkOut: range.checkOut, guests: String(guests) });
        const timer = setTimeout(() => {
            fetch(`/api/stays/quote?${q}`)
                .then((r) => r.json())
                .then((j: QuoteView & { error?: string }) => {
                    if (!alive) return;
                    setData(j.error ? { available: false, reason: j.error, nights: 0, totalCents: 0, currency: "RON" } : j);
                })
                .catch(() => alive && setData(null))
                .finally(() => alive && setLoading(false));
        }, 250);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [stayId, range.checkIn, range.checkOut, guests]);

    return { data, loading };
}
