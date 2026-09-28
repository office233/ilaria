import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { rateLimit } from "@/lib/security/rate-limit";
import { notBlockedSql } from "@/lib/social/blocks";
import { screenNewsComment } from "@/lib/news/comment-moderation";

export const dynamic = "force-dynamic";

const CommentCreateSchema = z.object({
  content: z.string().trim().min(2).max(2000),
  parent_id: z.string().uuid().nullish(),
});

interface CommentRow {
  id: string;
  article_id: string;
  user_id: string;
  content: string;
  parent_id: string | null;
  likes_count: number;
  created_at: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

async function resolveArticleId(slug: string): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM news_articles WHERE slug = $1 AND status = 'published' LIMIT 1`,
    [slug]
  );
  return rows[0]?.id ?? null;
}

/** GET /api/news/[slug]/comments — paginated list of published comments, newest first. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const { slug } = await params;
    const articleId = await resolveArticleId(slug);
    if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    // Comentariile utilizatorilor blocați (în orice sens) sunt ascunse vizitatorului autentificat.
    const viewer = await getAuthUser().catch(() => null);
    const viewerId = viewer?.userId ?? null;
    const { rows } = await dbQuery<CommentRow>(
      `SELECT c.id, c.article_id, c.user_id, c.content, c.parent_id, c.likes_count, c.created_at,
              u.display_name, u.username, u.avatar_url
       FROM news_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.article_id = $1 AND c.status = 'published'
         AND ($4::uuid IS NULL OR ${notBlockedSql("c.user_id", "$4")})
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [articleId, limit + 1, offset, viewerId]
    );

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json({
      ok: true,
      items: items.map((c) => ({
        id: c.id,
        content: c.content,
        parentId: c.parent_id,
        likesCount: c.likes_count,
        createdAt: c.created_at,
        author: { displayName: c.display_name, username: c.username, avatarUrl: c.avatar_url },
        isOwn: viewerId !== null && viewerId === c.user_id,
      })),
      hasMore,
      offset,
      limit,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[news comments GET] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}

/** POST /api/news/[slug]/comments — create a comment (auth required). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const user = await getAuthUser();
    if (!user.userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const rl = await rateLimit("newsComment", user.userId);
    if (!rl.success) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

    const { slug } = await params;
    const articleId = await resolveArticleId(slug);
    if (!articleId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const rawBody = await req.json().catch(() => null);
    const parsed = CommentCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid_body" }, { status: 400 });
    }

    let parentId: string | null = parsed.data.parent_id ?? null;
    if (parentId) {
      const { rows: parentRows } = await dbQuery<{ id: string }>(
        `SELECT id FROM news_comments WHERE id = $1 AND article_id = $2 LIMIT 1`,
        [parentId, articleId]
      );
      if (!parentRows[0]) parentId = null;
    }

    // Azure Content Safety: block → refuzat; review / indisponibil → ascuns pentru revizuire.
    const screen = await screenNewsComment(parsed.data.content);
    if (screen.status === "rejected") {
      return NextResponse.json({ ok: false, error: "comment_blocked" }, { status: 422 });
    }

    const { rows } = await dbQuery<{ id: string; created_at: string }>(
      `INSERT INTO news_comments (article_id, user_id, content, parent_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [articleId, user.userId, parsed.data.content, parentId, screen.status]
    );

    const pending = screen.status === "moderated";
    return NextResponse.json(
      { ok: true, id: rows[0].id, createdAt: rows[0].created_at, pending },
      { status: pending ? 202 : 201 }
    );
  } catch (err: unknown) {
    logger.error({ err }, "[news comments POST] failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
