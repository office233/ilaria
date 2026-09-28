/**
 * GET|POST /api/cron/prewarm-catalogs — la 15 min (cron-worker run.sh):
 * reîmprospătează în Redis cataloagele externe (Radio-Browser RO + top global +
 * curatoriate, Audius, Jamendo dacă e configurat, podcasturi) și prima pagină a
 * listelor de știri. Cererile citesc doar copia caldă (lib/prewarm/*).
 * Lock distribuit + audit prin runCron (lib/cron/lock.ts): o a doua rulare
 * concurentă → 200 skipped. O sursă căzută păstrează copia veche.
 */
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { refreshAllCatalogs } from "@/lib/prewarm/catalogs";
import { refreshNewsLists } from "@/lib/prewarm/news";
import { isEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const JOB = "prewarm-catalogs";

async function prewarm() {
    const [catalogs, news] = await Promise.all([
        refreshAllCatalogs(),
        isEnabled("news")
            ? refreshNewsLists().then(
                (lists) => ({ status: "ok" as const, lists }),
                (err: unknown) => {
                    logger.warn({ err }, "[prewarm] news lists refresh failed");
                    return { status: "error" as const, lists: 0 };
                },
            )
            : Promise.resolve({ status: "disabled" as const, lists: 0 }),
    ]);
    return { catalogs, news };
}

async function handle(req: Request): Promise<Response> {
    if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const result = await runCron(JOB, prewarm);
    if (result === null) return cronSkippedResponse(JOB);
    return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
