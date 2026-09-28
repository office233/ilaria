/**
 * GET /api/admin/go/overview — consola de dispatch: șoferi online (cu
 * heartbeat proaspăt), curse active, contoare zilnice. Consola îl citește la
 * intervalul NEXT_PUBLIC_GO_ADMIN_POLL_MS (implicit 10s).
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { getGoOverview } from "@/lib/rides/admin-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const actor = await requireAdmin(req, "mobility");
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await getGoOverview());
}
