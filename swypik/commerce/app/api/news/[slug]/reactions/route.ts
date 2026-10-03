import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const REACTION_TYPES = ["fire", "insightful", "mindblown", "rocket", "skeptical"] as const;
const ReactionBodySchema = z.object({
  reaction_type: z.enum(REACTION_TYPES),
});

async function resolveArticleId(slug: string): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM news_articles WHERE slug = $1 AND status = 'published' LIMIT 1`,
    [slug]
  );
  return rows[0]?.id ?? null;
}

/** GET /api/news/[slug]/reactions — counts per reaction_type + the caller's own reactions. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const { slug } = await params;
    const articleId = await resolveArticleId(slug);
    if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const { rows } = await dbQuery<{ reaction_type: string; count: string }>(
      `SELECT reaction_type, COUNT(*)::text as count
       FROM news_reactions
       WHERE article_id = $1
       GROUP BY reaction_type`,
      [articleId]
    );

    const counts: Record<string, number> = Object.fromEntries(REACTION_TYPES.map((t) => [t, 0]));
    for (const row of rows) counts[row.reaction_type] = Number(row.count);

    const user = await getAuthUser();
    let mine: string[] = [];
    if (user.userId) {
      const { rows: mineRows } = await dbQuery<{ reaction_type: string }>(
        `SELECT reaction_type FROM news_reactions WHERE article_id = $1 AND user_id = $2`,
        [articleId, user.userId]
      );
      mine = mineRows.map((r) => r.reaction_type);
    }

    return NextResponse.json({ ok: true, counts, mine });
  } catch (err: unknown) {
    logger.error({ err }, "[news reactions GET] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}

/** POST /api/news/[slug]/reactions — toggle add a reaction (auth required). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("newsReaction", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const articleId = await resolveArticleId(slug);
    if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const rawBody = await req.json().catch(() => null);
    const parsed = ReactionBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }

    await dbQuery(
      `INSERT INTO news_reactions (article_id, user_id, reaction_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (article_id, user_id, reaction_type) DO NOTHING`,
      [articleId, user.userId, parsed.data.reaction_type]
    );

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err: unknown) {
    logger.error({ err }, "[news reactions POST] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}

/** DELETE /api/news/[slug]/reactions — remove a reaction (auth required). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("newsReaction", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const articleId = await resolveArticleId(slug);
    if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const url = new URL(req.url);
    const reactionType = url.searchParams.get("reaction_type");
    const parsed = z.enum(REACTION_TYPES).safeParse(reactionType);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_reaction_type" }, { status: 400 });
    }

    await dbQuery(
      `DELETE FROM news_reactions WHERE article_id = $1 AND user_id = $2 AND reaction_type = $3`,
      [articleId, user.userId, parsed.data]
    );

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ err }, "[news reactions DELETE] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
