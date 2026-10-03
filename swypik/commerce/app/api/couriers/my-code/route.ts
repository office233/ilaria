/**
 * GET /api/couriers/my-code — codul de invitație al curierului/șoferului logat
 * + statistici referral (clienți aduși, câștig total).
 * Codul se generează lazy la prima cerere (doar pentru conturi aprobate).
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import {
  getOrCreateDriverCode,
  getDriverReferralStats,
  REFERRAL_DISCOUNT_PCT,
  REFERRAL_DISCOUNTED_RIDES,
  REFERRAL_FIRST_RIDE_BONUS_CENTS,
} from "@/lib/drivers/referral";
import { logger } from "@/lib/logger";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getAuthSession();
    if (!session?.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { rows } = await dbQuery<{ id: string; verification_status: string }>(
      `SELECT id, verification_status FROM couriers WHERE user_id = $1 LIMIT 1`,
      [session.userId],
    );
    if (!rows.length) return NextResponse.json({ error: "not_courier" }, { status: 404 });
    if (rows[0].verification_status !== "approved") {
      return NextResponse.json({ error: "not_approved" }, { status: 403 });
    }
    const courierId = rows[0].id;
    const code = await getOrCreateDriverCode(courierId);
    const stats = await getDriverReferralStats(courierId);
    return NextResponse.json({
      code,
      share_url: `${APP_URL}/r/${code}`,
      stats,
      terms: {
        discount_pct: REFERRAL_DISCOUNT_PCT,
        discounted_rides: REFERRAL_DISCOUNTED_RIDES,
        first_ride_bonus_cents: REFERRAL_FIRST_RIDE_BONUS_CENTS,
      },
    });
  } catch (err) {
    logger.error({ err }, "[couriers/my-code] failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
