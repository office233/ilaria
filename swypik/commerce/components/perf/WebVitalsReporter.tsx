"use client";

/**
 * RUM propriu: Core Web Vitals (biblioteca `web-vitals` inclusă în Next, prin
 * `useReportWebVitals`) → POST /api/vitals, grupate și trimise cu sendBeacon
 * când pagina e ascunsă/închisă. Fără cookie-uri noi, fără terți, eșantionat
 * (NEXT_PUBLIC_VITALS_SAMPLE_RATE). Nu randează nimic.
 */
import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { VITAL_NAMES, vitalsLimits, vitalsSampleRate, type VitalName } from "@/lib/perf/vitals-config";

type QueuedMetric = { name: VitalName; value: number; route: string };

const ENDPOINT = "/api/vitals";
const queue: QueuedMetric[] = [];
let sampled: boolean | null = null;

function isSampled(): boolean {
    if (sampled === null) sampled = Math.random() < vitalsSampleRate();
    return sampled;
}

function isVitalName(name: string): name is VitalName {
    return (VITAL_NAMES as readonly string[]).includes(name);
}

function flush(): void {
    if (queue.length === 0) return;
    const body = JSON.stringify({ metrics: queue.splice(0, vitalsLimits.maxBatch) });
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ENDPOINT, blob)) {
        return;
    }
    void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => undefined);
}

export function WebVitalsReporter() {
    useReportWebVitals((metric) => {
        if (!isSampled() || !isVitalName(metric.name)) return;
        queue.push({ name: metric.name, value: metric.value, route: window.location.pathname });
        if (queue.length >= vitalsLimits.maxBatch) flush();
    });

    useEffect(() => {
        const onHidden = () => {
            if (document.visibilityState === "hidden") flush();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("pagehide", flush);
        return () => {
            document.removeEventListener("visibilitychange", onHidden);
            window.removeEventListener("pagehide", flush);
        };
    }, []);

    return null;
}
