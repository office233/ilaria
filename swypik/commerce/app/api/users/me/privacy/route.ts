/**
 * Setări de confidențialitate ale profilului.
 *   GET   → { liked_videos_public }
 *   PATCH { liked_videos_public: boolean }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { SOCIAL_LIMITS } from "@/lib/social/config";
import { getAccountUserId } from "@/lib/social/session";

export const dynamic = "force-dynamic";

const PrivacySchema = z.object({ liked_videos_public: z.boolean() });

export async function GET() {
  const userId = await getAccountUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = await dbQuery<{ liked_videos_public: boolean }>(
    `SELECT liked_videos_public FROM users WHERE id = $1`,
    [userId],
  );
  return NextResponse.json({ liked_videos_public: Boolean(rows[0]?.liked_videos_public) });
}

export async function PATCH(req: Request) {
  try {
    const userId = await getAccountUserId();
    if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rl = await rateLimit("privacy_edit", userId, SOCIAL_LIMITS.privacyEdit);
    if (!rl.success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const parsed = PrivacySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    await dbQuery(`UPDATE users SET liked_videos_public = $1 WHERE id = $2`, [parsed.data.liked_videos_public, userId]);
    return NextResponse.json({ liked_videos_public: parsed.data.liked_videos_public });
  } catch (error) {
    logger.error({ err: error }, "[privacy] update failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
