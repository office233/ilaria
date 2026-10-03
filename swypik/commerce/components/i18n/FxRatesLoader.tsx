"use client";

/**
 * Încarcă o singură dată cursurile valutare reale de la `/api/fx` și le
 * injectează în `lib/i18n/fx`, ca prețurile afișate în alte monede să nu mai
 * folosească ratele înghețate din cod.
 *
 * Nu randează nimic. Montat în layout-ul root.
 */
import { useEffect } from "react";
import { setFxRates } from "@/lib/i18n/fx";

export default function FxRatesLoader() {
    useEffect(() => {
        let cancelled = false;
        fetch("/api/fx")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (!cancelled && data?.rates) setFxRates(data.rates);
            })
            .catch(() => {
                /* rămânem pe fallback-ul static */
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return null;
}
