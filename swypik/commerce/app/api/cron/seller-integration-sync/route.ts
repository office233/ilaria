import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { runSellerIntegrationMaintenance } from "@/lib/seller/imports/integration-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const JOB = "seller-integration-sync";

async function handle(req: Request): Promise<Response> {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runCron(JOB, runSellerIntegrationMaintenance);
  if (result === null) return cronSkippedResponse(JOB);
  return NextResponse.json({ success: true, ...result });
}

export const GET = handle;
export const POST = handle;
