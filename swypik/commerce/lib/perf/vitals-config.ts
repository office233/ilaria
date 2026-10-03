/**
 * RUM propriu (fără trackere terțe): Core Web Vitals trimise de browser la
 * POST /api/vitals, agregate în Redis per rută (lib/perf/vitals-store.ts),
 * afișate ca p75 în /admin/health. Modul pur, sigur pentru client.
 */
import { LOCALES } from "@/lib/i18n/config";

export const VITAL_NAMES = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

/** Pragurile Google (good ≤ primul, poor > al doilea). */
export const VITAL_THRESHOLDS: Record<VitalName, readonly [number, number]> = {
    LCP: [2500, 4000],
    INP: [200, 500],
    CLS: [0.1, 0.25],
    FCP: [1800, 3000],
    TTFB: [800, 1800],
};

/** Valori plauzibile; restul sunt zgomot (tab în fundal ore întregi etc.). */
export const VITAL_MAX: Record<VitalName, number> = {
    LCP: 120_000,
    INP: 60_000,
    CLS: 50,
    FCP: 120_000,
    TTFB: 120_000,
};

export type VitalRating = "good" | "needs-improvement" | "poor";

export function rateVital(name: VitalName, value: number): VitalRating {
    const [good, poor] = VITAL_THRESHOLDS[name];
    if (value <= good) return "good";
    return value <= poor ? "needs-improvement" : "poor";
}

export const vitalsLimits = {
    /** Metrici per trimitere (o pagină produce ≤ 5). */
    maxBatch: 10,
    /** Octeți acceptați pe corpul cererii. */
    maxBodyBytes: 4096,
    /** Ultimele N eșantioane per (rută, metrică) — p75 pe fereastra asta. */
    samplesPerSeries: 500,
    /** Rute distincte urmărite; restul intră în „other” (cardinalitate mărginită). */
    maxRoutes: 200,
    /** Seriile expiră dacă nu mai primesc date. */
    ttlSeconds: 7 * 86_400,
    maxRouteLength: 120,
    /** Trimiteri per IP pe minut (un tab trimite ~1–2 / vizualizare). */
    ratePerMinute: 60,
} as const;

/** Fracțiunea de vizite care raportează (NEXT_PUBLIC_VITALS_SAMPLE_RATE, 0–1). */
export function vitalsSampleRate(): number {
    const raw = (process.env.NEXT_PUBLIC_VITALS_SAMPLE_RATE || "").trim();
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
}

const LOCALE_PREFIX = new RegExp(`^/(?:${LOCALES.join("|")})(?=/|$)`);
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{16,}|.*\d.*-.*|.*-.*\d.*)$/i;

/**
 * Eticheta de rută, fără limbă și fără identificatori (`/ro/product/<uuid>` →
 * `/product/:id`): cardinalitate mică, niciun identificator în Redis.
 */
export function normalizeRoute(pathname: string): string {
    const path = (pathname.split(/[?#]/)[0] || "/").replace(LOCALE_PREFIX, "") || "/";
    const segments = path
        .split("/")
        .filter(Boolean)
        .slice(0, 4)
        .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg.toLowerCase().replace(/[^a-z0-9_-]/g, "")))
        .filter(Boolean);
    const label = `/${segments.join("/")}`;
    return label.slice(0, vitalsLimits.maxRouteLength);
}

/** Percentila p (0–100) prin rang cel mai apropiat. */
export function percentile(values: readonly number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
