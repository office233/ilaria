/**
 * GET/POST /api/cron/daily-maintenance — ORCHESTRATOR de mentenanță zilnică.
 * Protejat cu header x-cron-secret = env CRON_SECRET.
 *
 * Rulare (crontab, o dată pe zi la 04:15):
 *   15 4 * * * curl -s -o /dev/null -H "x-cron-secret: $CRON_SECRET" https://swypik.com/api/cron/daily-maintenance
 *
 * ATENȚIE — programarea principală o face `cron-worker`
 * (infra/hetzner/cron-worker/run.sh): el rulează deja publish-scheduled,
 * refresh-rank, watchdog-videos, embed-batch, classify-pending,
 * process-payouts, refresh-fx, abandoned-cart, detect-trends, email-digest,
 * suspend-unverified, strikes-decay și cleanup-tokens.
 *
 * Aici rulăm DOAR ce nu acoperă worker-ul, ca să nu dublăm execuțiile:
 *   - retrogradarea founding drivers (inline)
 *   - reconcile-wallets (verificare integritate ledger — lipsea complet)
 *   - aggregate-video-stats (lipsea complet)
 * Fiecare job e izolat la erori — unul picat NU le oprește pe celelalte.
 */
import { NextResponse } from "next/server";
import { demoteInactiveFoundingDrivers } from "@/lib/drivers/tiers";
import { privatizeExpiredMovieTitles } from "@/lib/movies/visibility";
import { logger } from "@/lib/logger";
import { withCronLock } from "@/lib/cron/lock";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = logger.child({ mod: "cron/daily-maintenance" });

/**
 * Joburi delegate — DOAR cele neacoperite de cron-worker.
 * Înainte de a adăuga aici ceva, verifică infra/hetzner/cron-worker/run.sh.
 */
const DAILY_JOBS = [
    "reconcile-wallets",     // integritate ledger — nu era programat nicăieri
    "aggregate-video-stats", // statistici video — nu era programat nicăieri
] as const;

async function handle(req: Request) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const got = req.headers.get("x-cron-secret");
    if (!got || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Exact-once între replici: o a doua declanșare concurentă iese imediat (200 skipped).
    return withCronLock("daily-maintenance", () => runDailyMaintenance(secret));
}

async function runDailyMaintenance(secret: string): Promise<Response> {
    const results: Record<string, unknown> = {};

    // 1. Job istoric, inline.
    try {
        results["founding-demotion"] = { demoted: await demoteInactiveFoundingDrivers() };
    } catch (err) {
        log.error({ err }, "founding demotion failed");
        results["founding-demotion"] = { error: String((err as Error)?.message ?? err) };
    }

    // 1b. Movies: titlurile cu licența expirată ies din feed (episoadele gratuite devin private).
    try {
        results["movies-license-expiry"] = await privatizeExpiredMovieTitles();
    } catch (err) {
        log.error({ err }, "movies license expiry failed");
        results["movies-license-expiry"] = { error: String((err as Error)?.message ?? err) };
    }

    // 2. Joburile delegate, în serie (evită vârf de DB la 4 dimineața).
    const base = process.env.CRON_INTERNAL_BASE || "http://127.0.0.1:3000";
    for (const job of DAILY_JOBS) {
        try {
            const r = await fetch(`${base}/api/cron/${job}`, {
                headers: { "x-cron-secret": secret },
                signal: AbortSignal.timeout(120000),
            });
            const body = await r.json().catch(() => ({}));
            results[job] = { status: r.status, ...body };
        } catch (err) {
            log.error({ err, job }, "daily job failed");
            results[job] = { error: String((err as Error)?.message ?? err) };
        }
    }

    const failed = Object.values(results).filter(
        (r: any) => r?.error || (typeof r?.status === "number" && r.status >= 400),
    ).length;
    log.info({ failed, total: Object.keys(results).length }, "daily maintenance done");
    return NextResponse.json({ success: failed === 0, failed, results });
}

export async function GET(req: Request) {
    return handle(req);
}
export async function POST(req: Request) {
    return handle(req);
}
