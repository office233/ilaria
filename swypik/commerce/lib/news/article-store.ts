/**
 * Write side of the news ingester. Every step is idempotent so the cron can
 * run as often as it likes (and overlap) without duplicating stories:
 *  - claimRawItem: atomic claim on news_raw_items.url (UNIQUE). A URL already
 *    processed — or exhausted its retries — is never generated again.
 *  - insertArticle: never overwrites an existing slug; a clash gets a
 *    deterministic suffix derived from the source URL.
 */
import { createHash } from "node:crypto";
import { dbQuery } from "@/lib/db";
import type { GeneratedArticle } from "./ai-journalist";
import type { FeedTopic } from "./rss-parser";

export async function claimRawItem(topic: FeedTopic, maxAttempts: number): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO news_raw_items (url, title, raw_content, author, source_id, published_at, is_processed, category_hint, attempts)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), false, $7, 1)
     ON CONFLICT (url) DO UPDATE
       SET attempts = news_raw_items.attempts + 1
     WHERE news_raw_items.is_processed = false AND news_raw_items.attempts < $8
     RETURNING id`,
    [topic.url, topic.title, topic.summary, topic.source, topic.sourceId, topic.publishedAt, topic.category, maxAttempts],
  );
  return rows[0]?.id ?? null;
}

export async function markRawItemProcessed(rawItemId: string): Promise<void> {
  await dbQuery(`UPDATE news_raw_items SET is_processed = true WHERE id = $1`, [rawItemId]);
}

export function slugSuffix(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 6);
}

type InsertInput = {
  generated: GeneratedArticle;
  topic: FeedTopic;
  categoryId: string;
  status: "published" | "draft";
  model: string;
};

/** Returns the new article id, or null if both the slug and its suffixed variant already exist. */
export async function insertArticle({ generated, topic, categoryId, status, model }: InsertInput): Promise<string | null> {
  const base = generated.slug.slice(0, 170);
  for (const slug of [base, `${base}-${slugSuffix(topic.url)}`]) {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO news_articles (
         slug, category_id, title, summary_tldr, content_markdown, cover_image_url,
         is_breaking, reading_time_minutes, fact_check_score, fact_check_notes,
         ai_model_name, status, published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, 0, NULL, $8, $9, now())
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, categoryId, generated.title, generated.summary_tldr, generated.content_markdown, topic.imageUrl ?? "", generated.reading_time_minutes, model, status],
    );
    const id = rows[0]?.id;
    if (id) {
      await dbQuery(
        `INSERT INTO news_article_sources (article_id, source_id, original_url, original_title) VALUES ($1, $2, $3, $4)`,
        [id, topic.sourceId, topic.url, topic.title],
      );
      return id;
    }
  }
  return null;
}

export async function categoryIdForSlug(slug: string): Promise<string | null> {
  const { rows } = await dbQuery<{ id: string }>(`SELECT id FROM news_categories WHERE slug = $1 AND is_active = true LIMIT 1`, [slug]);
  return rows[0]?.id ?? null;
}
