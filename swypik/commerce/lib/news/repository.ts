/**
 * lib/news/repository.ts — public read side of the News module.
 *
 * Only published articles WITH an original source are ever returned: every
 * story on Swypik must carry its attribution + link (an article without a
 * news_article_sources row is treated as not publishable).
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { NewsCategorySlug } from "./categories";
import { NEWS_MAX_PAGE_SIZE, NEWS_PAGE_SIZE } from "./config";

export interface NewsArticleListItem {
  id: string;
  slug: string;
  title: string;
  summary_tldr: string;
  /** Image from the original feed item; empty string when the feed had none. */
  cover_image_url: string;
  reading_time_minutes: number;
  view_count: number;
  published_at: string;
  category_name: string;
  category_slug: string;
  source_name: string | null;
  source_url: string;
}

export interface NewsArticleSource {
  original_url: string;
  original_title: string | null;
  source_name: string | null;
}

export interface NewsArticleDetail extends NewsArticleListItem {
  content_markdown: string;
  sources: NewsArticleSource[];
}

/** First (primary) source of an article; INNER lateral join = articles without a source are excluded. */
const PRIMARY_SOURCE_JOIN = `
  JOIN LATERAL (
    SELECT nas.original_url AS source_url, COALESCE(ns.name, nri.author) AS source_name
      FROM news_article_sources nas
      LEFT JOIN news_sources ns ON ns.id = nas.source_id
      LEFT JOIN news_raw_items nri ON nri.url = nas.original_url
     WHERE nas.article_id = a.id
     ORDER BY nas.created_at ASC
     LIMIT 1
  ) src ON true
`;

const LIST_COLUMNS = `
  a.id, a.slug, a.title, a.summary_tldr, a.cover_image_url,
  a.reading_time_minutes, a.view_count, a.published_at,
  c.name AS category_name, c.slug AS category_slug,
  src.source_name, src.source_url
`;

export function clampPageSize(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? Math.trunc(limit as number) : NEWS_PAGE_SIZE;
  return Math.min(NEWS_MAX_PAGE_SIZE, Math.max(1, n));
}

export async function listArticles(opts: {
  category?: NewsCategorySlug | null;
  limit?: number;
  offset?: number;
}): Promise<NewsArticleListItem[]> {
  const params: unknown[] = [];
  let where = `a.status = 'published'`;
  if (opts.category) {
    params.push(opts.category);
    where += ` AND c.slug = $${params.length}`;
  }
  // +1 headroom so callers can probe for a next page with limit = page + 1.
  params.push(Math.min(NEWS_MAX_PAGE_SIZE + 1, Math.max(1, Math.trunc(opts.limit ?? NEWS_PAGE_SIZE))));
  const limitIdx = params.length;
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  let offsetSql = "";
  if (offset > 0) {
    params.push(offset);
    offsetSql = ` OFFSET $${params.length}`;
  }

  const { rows } = await dbQuery<NewsArticleListItem>(
    `SELECT ${LIST_COLUMNS}
       FROM news_articles a
       JOIN news_categories c ON a.category_id = c.id
       ${PRIMARY_SOURCE_JOIN}
      WHERE ${where}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT $${limitIdx}${offsetSql}`,
    params,
  );
  return rows;
}

export async function getArticleBySlug(slug: string): Promise<NewsArticleDetail | null> {
  if (!slug || typeof slug !== "string" || slug.length > 200) return null;

  const { rows } = await dbQuery<NewsArticleListItem & { content_markdown: string }>(
    `SELECT ${LIST_COLUMNS}, a.content_markdown
       FROM news_articles a
       JOIN news_categories c ON a.category_id = c.id
       ${PRIMARY_SOURCE_JOIN}
      WHERE a.slug = $1 AND a.status = 'published'
      LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: sources } = await dbQuery<NewsArticleSource>(
    `SELECT nas.original_url, nas.original_title, COALESCE(ns.name, nri.author) AS source_name
       FROM news_article_sources nas
       LEFT JOIN news_sources ns ON ns.id = nas.source_id
       LEFT JOIN news_raw_items nri ON nri.url = nas.original_url
      WHERE nas.article_id = $1
      ORDER BY nas.created_at ASC`,
    [row.id],
  );
  return { ...row, sources };
}

/** Best-effort view counter (the article page calls it once per render). */
export async function incrementViewCount(articleId: string): Promise<void> {
  try {
    await dbQuery(`UPDATE news_articles SET view_count = view_count + 1 WHERE id = $1`, [articleId]);
  } catch (err) {
    logger.warn({ err }, "[news] incrementViewCount failed");
  }
}

/** Articles created today (any status) — the daily AI-generation cap. */
export async function countArticlesPublishedToday(): Promise<number> {
  const { rows } = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM news_articles WHERE created_at >= date_trunc('day', now())`,
  );
  return Number(rows[0]?.count || "0");
}
