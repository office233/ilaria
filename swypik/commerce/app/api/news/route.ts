import { NextRequest, NextResponse } from "next/server";
import { isEnabled, frozenResponse } from "@/lib/feature-flags";
import { listArticles, getArticleBySlug, clampPageSize } from "@/lib/news/repository";
import { parseCategoryFilter } from "@/lib/news/categories";
import { logger } from "@/lib/logger";
import { applyCachePolicy } from "@/lib/http/cache-policy";
import { getNewsFirstPage } from "@/lib/prewarm/news";
import { NEWS_PAGE_SIZE } from "@/lib/news/config";

export const dynamic = "force-dynamic";

const MAX_OFFSET = 1000;

/**
 * GET /api/news?category=&limit=&offset= — published, source-attributed articles.
 * GET /api/news?slug= — one article (no view counting here; the article page counts).
 */
export async function GET(req: NextRequest) {
  if (!isEnabled("news")) return frozenResponse("news");

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");

    if (slug) {
      const article = await getArticleBySlug(slug);
      if (!article) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      return applyCachePolicy(NextResponse.json({ ok: true, article }), "news", req);
    }

    const limit = clampPageSize(Number(url.searchParams.get("limit") ?? undefined));
    const offset = Math.min(MAX_OFFSET, Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0)));
    // One extra row tells us whether another page exists.
    const category = parseCategoryFilter(url.searchParams.get("category"));
    // Prima pagină implicită vine din copia caldă (Redis, lib/prewarm/news.ts).
    const rows = offset === 0 && limit === NEWS_PAGE_SIZE
      ? await getNewsFirstPage(category)
      : await listArticles({ category, limit: limit + 1, offset });

    return applyCachePolicy(
      NextResponse.json({ ok: true, articles: rows.slice(0, limit), hasMore: rows.length > limit }),
      "news",
      req,
    );
  } catch (err: unknown) {
    logger.error({ err }, "[news] GET failed");
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}
