/**
 * GET|POST /api/cron/food-orders-watchdog — la fiecare minut (cron-worker):
 * sincronizează hold-urile de card, anulează comenzile Food neacceptate la timp
 * (cu refund) și raportează comenzile blocate. Vezi lib/food/watchdog.ts.
 * Auth: x-cron-secret / Bearer CRON_SECRET.
 */
import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { runFoodWatchdog } from "@/lib/food/watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runCron("food-orders-watchdog", runFoodWatchdog);
  if (result === null) return cronSkippedResponse("food-orders-watchdog");
  return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
