import { NextRequest, NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DELETE /api/news/[slug]/comments/[id] — soft-delete own comment (auth required). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("newsCommentDelete", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
    }

    const { rows } = await dbQuery<{ id: string }>(
      `UPDATE news_comments
       SET status = 'deleted'
       WHERE id = $1 AND user_id = $2 AND status = 'published'
       RETURNING id`,
      [id, user.userId]
    );

    if (!rows[0]) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ err }, "[news comment DELETE] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
