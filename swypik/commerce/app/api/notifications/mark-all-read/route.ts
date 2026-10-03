import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

async function POST_impl() {
  const userId = await getOptionalSocialUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("notifMarkRead", userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { rowCount } = await dbQuery(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1
        AND read_at IS NULL`,
    [userId],
  );

  return NextResponse.json({ ok: true, updated: rowCount });
}

export const POST = withErrorHandling(POST_impl);
