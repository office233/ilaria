/**
 * GET /api/missions — misiunile deschise (active, finanțate, RON), public.
 */
import { NextResponse } from "next/server";
import { listOpenMissions } from "@/lib/missions/repo";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  try {
    const missions = await listOpenMissions(limit);
    return applyCachePolicy(NextResponse.json({ missions }), "missions", req);
  } catch (err) {
    logger.error({ err }, "[api/missions] GET failed");
    return NextResponse.json({ error: "internal_error", missions: [] }, { status: 500 });
  }
}
