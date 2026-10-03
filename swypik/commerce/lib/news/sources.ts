/**
 * Active RSS sources from news_sources (admin-managed; seeded by migrations
 * 20260924_0002 + 20260926_0123). There is no hardcoded fallback list: an
 * empty table means nothing to ingest, never invented sources.
 */
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isNewsCategory, type NewsCategorySlug } from "./categories";

export type NewsSource = { id: string; name: string; feedUrl: string; category: NewsCategorySlug };

type SourceRow = { id: string; name: string; feed_url: string; category_slug: string | null; last_fetched_at: string | null };

export async function loadActiveSources(targetCategory: NewsCategorySlug | null, max: number): Promise<NewsSource[]> {
  try {
    // Least-recently fetched first, so a per-run source cap still rotates through all feeds.
    const { rows } = await dbQuery<SourceRow>(
      `SELECT s.id, s.name, s.feed_url, c.slug AS category_slug, s.last_fetched_at
         FROM news_sources s
         JOIN news_categories c ON c.id = s.category_id AND c.is_active = true
        WHERE s.is_active = true
        ORDER BY s.last_fetched_at ASC NULLS FIRST, s.name ASC`,
    );
    return rows
      .filter((r) => isNewsCategory(r.category_slug))
      .map((r) => ({ id: r.id, name: r.name, feedUrl: r.feed_url, category: r.category_slug as NewsCategorySlug }))
      .filter((s) => !targetCategory || s.category === targetCategory)
      .slice(0, max);
  } catch (err) {
    logger.error({ err }, "[news] failed to load news_sources");
    return [];
  }
}

export async function markSourceFetched(sourceId: string): Promise<void> {
  try {
    await dbQuery(`UPDATE news_sources SET last_fetched_at = now() WHERE id = $1`, [sourceId]);
  } catch (err) {
    logger.warn({ err, sourceId }, "[news] failed to update news_sources.last_fetched_at");
  }
}
