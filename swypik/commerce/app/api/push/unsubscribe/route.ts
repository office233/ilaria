/**
 * POST /api/push/unsubscribe
 * Body: { endpoint }
 * Marchează tokenul ca revocat (soft delete — păstrăm istoricul).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { rateLimit } from "@/lib/security/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UnsubscribeSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
});

export async function POST(req: Request) {
  try {
    const session = await getAuthSession();
    if (!session?.userId) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
    }

    const rl = await rateLimit("pushSubscribe", session.userId);
    if (!rl.success) {
      return NextResponse.json({ success: false, error: "rate_limited" }, { status: 429 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = UnsubscribeSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "invalid_input" }, { status: 400 });
    }

    const { rowCount } = await dbQuery(
      `UPDATE user_push_tokens SET revoked_at = now()
        WHERE endpoint = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [parsed.data.endpoint, session.userId],
    );

    logger.info({ userId: session.userId, revoked: rowCount }, "push.unsubscribe");
    return NextResponse.json({ success: true, revoked: rowCount });
  } catch (err) {
    logger.error({ error: (err as Error).message }, "push.unsubscribe.error");
    return NextResponse.json({ success: false, error: "internal_error" }, { status: 500 });
  }
}
