/**
 * GET|POST /api/cron/live-sweep — la fiecare minut (cron-worker run.sh):
 * încheie streamurile Live a căror gazdă nu mai trimite heartbeat (SFU-ul
 * Cloudflare nu are webhooks) și scrie numărul de spectatori din Redis în DB.
 * Vezi lib/live/sweep.ts. Lock distribuit + audit prin runCron.
 * Auth: x-cron-secret / Bearer CRON_SECRET (timingSafeEqual).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { isLiveMediaConfigured } from "@/lib/live/config";
import { sweepLiveStreams } from "@/lib/live/sweep";

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
  // Fără SFU/Redis nu există heartbeat-uri de verificat (dar nici streamuri SFU live).
  if (!isLiveMediaConfigured()) return NextResponse.json({ success: true, skipped: true, reason: "live_unavailable" });
  const result = await runCron("live-sweep", sweepLiveStreams);
  if (result === null) return cronSkippedResponse("live-sweep");
  return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
