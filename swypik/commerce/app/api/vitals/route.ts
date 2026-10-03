/**
 * POST /api/vitals — RUM propriu: Core Web Vitals din browser
 * (components/perf/WebVitalsReporter.tsx, prin sendBeacon), agregate în Redis
 * per rută (lib/perf/vitals-store.ts), p75 în /admin/health. Fără cookie-uri,
 * fără identificatori de utilizator; limitat per IP.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { VITAL_MAX, VITAL_NAMES, normalizeRoute, vitalsLimits } from "@/lib/perf/vitals-config";
import { recordVitals, type VitalSample } from "@/lib/perf/vitals-store";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MetricSchema = z.object({
    name: z.enum(VITAL_NAMES),
    value: z.number().finite().nonnegative(),
    route: z.string().min(1).max(512),
});
const BodySchema = z.object({ metrics: z.array(MetricSchema).min(1).max(vitalsLimits.maxBatch) });

export async function POST(req: Request): Promise<Response> {
    const rl = await rateLimit("vitals", getClientIP(req), { limit: vitalsLimits.ratePerMinute, window: 60 });
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const length = Number(req.headers.get("content-length") || 0);
    if (length > vitalsLimits.maxBodyBytes) return NextResponse.json({ error: "too_large" }, { status: 413 });
    const text = await req.text().catch(() => "");
    if (text.length > vitalsLimits.maxBodyBytes) return NextResponse.json({ error: "too_large" }, { status: 413 });

    let json: unknown = null;
    try {
        json = JSON.parse(text);
    } catch {
        // corp invalid → 400 mai jos
    }
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

    const samples: VitalSample[] = parsed.data.metrics
        .filter((m) => m.value <= VITAL_MAX[m.name])
        .map((m) => ({ name: m.name, value: m.value, route: normalizeRoute(m.route) }));
    try {
        await recordVitals(samples);
    } catch (err: unknown) {
        // Telemetria nu are voie să producă erori vizibile; doar log.
        logger.warn({ err }, "[vitals] record failed");
    }
    return new NextResponse(null, { status: 204 });
}
