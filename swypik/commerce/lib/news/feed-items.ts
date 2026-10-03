/**
 * News articles as normalized cards for the Home feed (every module appears
 * as cards in the feed). Stable, UI-free contract:
 *   { kind: "news", id, title, summary, image, href, category, sourceName, sourceUrl, publishedAt }
 * Only published articles that carry their original source (attribution +
 * link are mandatory on every news card).
 */
import { clampFeedLimit } from "@/lib/media/feed-card";
import type { NewsCategorySlug } from "./categories";
import { listArticles, type NewsArticleListItem } from "./repository";
import { plainSummary, sourceLabel } from "./text";

export type NewsFeedItem = {
  kind: "news";
  id: string;
  title: string;
  /** Plain-text TL;DR (no emoji/line breaks), already truncated for a card. */
  summary: string;
  /** Image from the original feed item; null when it had none. */
  image: string | null;
  /** Internal route without locale prefix. */
  href: string;
  category: string;
  categoryName: string;
  /** Publisher shown on the card ("via BBC Business"). */
  sourceName: string;
  /** Link to the original article. */
  sourceUrl: string;
  publishedAt: string;
};

/** Pure row → card mapping (testable without a DB). */
export function toNewsFeedItem(row: NewsArticleListItem): NewsFeedItem | null {
  if (!row.source_url) return null;
  return {
    kind: "news",
    id: row.id,
    title: row.title,
    summary: plainSummary(row.summary_tldr),
    image: row.cover_image_url ? row.cover_image_url : null,
    href: `/news/${row.slug}`,
    category: row.category_slug,
    categoryName: row.category_name,
    sourceName: sourceLabel(row.source_name, row.source_url),
    sourceUrl: row.source_url,
    publishedAt: new Date(row.published_at).toISOString(),
  };
}

export async function getNewsFeedItems(opts: { limit?: number; category?: NewsCategorySlug | null } = {}): Promise<NewsFeedItem[]> {
  const rows = await listArticles({ category: opts.category ?? null, limit: clampFeedLimit(opts.limit) });
  return rows.map(toNewsFeedItem).filter((x): x is NewsFeedItem => x !== null);
}
