/**
 * GET|POST /api/cron/stays-lifecycle — la 5 minute (cron-worker run.sh):
 * expiră hold-urile neplătite și cererile fără răspuns (eliberând banii) și
 * marchează sejururile încheiate. Vezi lib/stays/lifecycle.ts.
 * Auth: x-cron-secret / Bearer CRON_SECRET (timingSafeEqual).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { runStaysLifecycle } from "@/lib/stays/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
    const token = req.headers.get("authorization")?.replace("Bearer ", "") || req.headers.get("x-cron-secret") || "";
    const expected = process.env.CRON_SECRET || "";
    if (!expected || !token || Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function handle(req: Request): Promise<Response> {
    if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const result = await runCron("stays-lifecycle", runStaysLifecycle);
    if (result === null) return cronSkippedResponse("stays-lifecycle");
    return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
