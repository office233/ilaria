/**
 * Admin side of News: review queue (drafts from NEWS_PUBLISH_MODE=review),
 * publish / archive / back-to-draft. Nothing is ever deleted.
 */
import { dbQuery } from "@/lib/db";
import type { AdminNewsRow, AdminNewsStatus } from "./admin-types";
import { logger } from "@/lib/logger";
import { invalidateNewsLists } from "@/lib/prewarm/news";

export { ADMIN_NEWS_STATUSES } from "./admin-types";
export type { AdminNewsRow, AdminNewsStatus } from "./admin-types";

export async function listArticlesForAdmin(status: AdminNewsStatus, limit: number, offset: number): Promise<AdminNewsRow[]> {
  const { rows } = await dbQuery<AdminNewsRow>(
    `SELECT a.id, a.slug, a.title, a.summary_tldr, a.status, c.slug AS category_slug,
            a.created_at, a.published_at, a.ai_model_name, src.source_name, src.source_url
       FROM news_articles a
       JOIN news_categories c ON c.id = a.category_id
       LEFT JOIN LATERAL (
         SELECT nas.original_url AS source_url, COALESCE(ns.name, nri.author) AS source_name
           FROM news_article_sources nas
           LEFT JOIN news_sources ns ON ns.id = nas.source_id
           LEFT JOIN news_raw_items nri ON nri.url = nas.original_url
          WHERE nas.article_id = a.id
          ORDER BY nas.created_at ASC
          LIMIT 1
       ) src ON true
      WHERE a.status = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3`,
    [status, Math.min(100, Math.max(1, limit)), Math.max(0, offset)],
  );
  return rows;
}

export type StatusChange = { ok: true; row: { id: string; status: AdminNewsStatus } } | { ok: false; error: "not_found" | "no_source" };

/**
 * Publishing requires an original source (attribution + link); publishing a
 * draft stamps published_at = now() so it lands at the top of the feed.
 */
export async function setArticleStatus(id: string, status: AdminNewsStatus, reviewerId: string | null): Promise<StatusChange> {
  if (status === "published") {
    const { rows } = await dbQuery<{ n: number }>(`SELECT count(*)::int AS n FROM news_article_sources WHERE article_id = $1`, [id]);
    if (Number(rows[0]?.n ?? 0) === 0) {
      const exists = await dbQuery(`SELECT 1 FROM news_articles WHERE id = $1`, [id]);
      return { ok: false, error: exists.rows.length ? "no_source" : "not_found" };
    }
  }
  const { rows } = await dbQuery<{ id: string; status: AdminNewsStatus }>(
    `UPDATE news_articles
        SET status = $2,
            published_at = CASE WHEN $2 = 'published' AND status <> 'published' THEN now() ELSE published_at END,
            reviewed_by = $3,
            reviewed_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING id, status`,
    [id, status, reviewerId],
  );
  if (!rows[0]) return { ok: false, error: "not_found" };
  // Lista publică de știri e ținută caldă în Redis — o retragere trebuie să dispară imediat.
  await invalidateNewsLists().catch((err: unknown) => logger.warn({ err }, "[news-admin] warm list invalidation failed"));
  return { ok: true, row: rows[0] };
}

export type NewsHealthCounts = { activeSources: number; drafts: number; published: number; publishedLast24h: number };

/** Numere pentru cardul de sănătate din /admin/news (de ce e /api/news gol?). */
export async function getNewsHealthCounts(): Promise<NewsHealthCounts> {
  const { rows } = await dbQuery<{ sources: number; drafts: number; published: number; recent: number }>(
    `SELECT (SELECT count(*)::int FROM news_sources WHERE is_active = true) AS sources,
            (SELECT count(*)::int FROM news_articles WHERE status = 'draft') AS drafts,
            (SELECT count(*)::int FROM news_articles WHERE status = 'published') AS published,
            (SELECT count(*)::int FROM news_articles
              WHERE status = 'published' AND published_at > now() - interval '24 hours') AS recent`,
  );
  const r = rows[0];
  return {
    activeSources: Number(r?.sources ?? 0),
    drafts: Number(r?.drafts ?? 0),
    published: Number(r?.published ?? 0),
    publishedLast24h: Number(r?.recent ?? 0),
  };
}
