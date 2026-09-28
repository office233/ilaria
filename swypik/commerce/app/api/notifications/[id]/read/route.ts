import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getOptionalSocialUserId } from "@/lib/social/session";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

async function POST_impl(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getOptionalSocialUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("notifMarkRead", userId);
  if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const { rowCount } = await dbQuery(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND read_at IS NULL`,
    [id, userId],
  );

  return NextResponse.json({ ok: true, updated: rowCount });
}

export const POST = withErrorHandling(POST_impl);
