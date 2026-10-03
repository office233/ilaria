"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";

/** Formatare bani/date în limba curentă (date YYYY-MM-DD interpretate în UTC). */
export function useStaysFormat() {
    const locale = useLocale();
    return useMemo(() => {
        const short = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
        const long = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
        const stamp = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        return {
            money: (cents: number, currency = "RON") =>
                new Intl.NumberFormat(locale, {
                    style: "currency",
                    currency,
                    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
                    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
                }).format(cents / 100),
            date: (iso: string) => short.format(new Date(`${iso}T00:00:00Z`)),
            longDate: (iso: string) => long.format(new Date(`${iso}T00:00:00Z`)),
            /** Moment exact (timestamptz), în fusul local al utilizatorului. */
            dateTime: (ts: string) => stamp.format(new Date(ts)),
        };
    }, [locale]);
}

/** Traduce un cod de eroare de la API (`{ error: code }`) cu fallback generic. */
export function errorKey(code: unknown): string {
    return typeof code === "string" && /^[a-z_]+$/.test(code) ? `errors.${code}` : "errors.internal_error";
}
