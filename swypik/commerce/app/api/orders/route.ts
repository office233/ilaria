import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { rows } = await dbQuery(
      `SELECT id, status, total_cents, currency, created_at
         FROM commerce_orders
        WHERE buyer_user_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [userId]
    );
    return NextResponse.json({ orders: rows });
  } catch (e: unknown) {
    logger.error({ err: e }, "GET /api/orders failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
