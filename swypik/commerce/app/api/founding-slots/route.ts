/**
 * GET /api/founding-slots — sloturile rămase pentru programul Founding Drivers.
 * Public (alimentează contorul de pe /join). Cache 60s.
 */
import { NextResponse } from "next/server";
import { getTierSlots, getTierParams, TIER_COMMISSION_PCT } from "@/lib/drivers/tiers";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const [slots, tierParams] = await Promise.all([getTierSlots(), getTierParams()]);
    return applyCachePolicy(
      NextResponse.json({ slots, tiers: TIER_COMMISSION_PCT, promo_days: tierParams.promoDays }),
      "founding-slots",
      req,
    );
  } catch (err) {
    logger.error({ err }, "[founding-slots] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
