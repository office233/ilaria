/** GET /api/users/me/stats — statisticile profilului propriu (același modul ca /u/<username>). */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getProfileStats } from "@/lib/social/profile/stats";
import { getAccountUserId } from "@/lib/social/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await getAccountUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const stats = await getProfileStats(userId);
    return NextResponse.json({ stats }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error({ err: error }, "[users/me/stats] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
