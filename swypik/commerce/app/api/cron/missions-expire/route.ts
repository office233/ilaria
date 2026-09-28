/**
 * GET|POST /api/cron/missions-expire — la fiecare oră (cron-worker run.sh):
 * închide misiunile active expirate (ends_at + MISSION_EXPIRE_GRACE_DAYS pentru
 * jurizare) fără câștigători neplătiți și returnează restul din escrow
 * sellerului (lib/missions/funding.ts → closeMission, cu lock pe misiune).
 * Lock distribuit + audit prin runCron. Auth: Bearer CRON_SECRET / x-cron-secret.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { closeExpiredMissions } from "@/lib/missions/funding";
import { missionExpireConfig } from "@/lib/missions/config";

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
  const result = await runCron("missions-expire", () => closeExpiredMissions(missionExpireConfig()));
  if (result === null) return cronSkippedResponse("missions-expire");
  // Refund-uri eșuate (ex. Stripe indisponibil): 502 → vizibil ca FAIL în logurile cron-worker.
  return NextResponse.json({ success: result.failed === 0, ...result }, { status: result.failed > 0 ? 502 : 200 });
}

export const GET = handle;
export const POST = handle;
