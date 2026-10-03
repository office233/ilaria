-- 20260924_0005_news_fixes.sql
-- Follow-up hardening for the AI News module (20260924_0002_ai_news.sql).
-- Idempotent: safe to run even if partially applied.

BEGIN;

-- Faster pagination for the comments thread (list published comments newest-first).
CREATE INDEX IF NOT EXISTS idx_news_comments_article_created
  ON news_comments(article_id, created_at DESC)
  WHERE status = 'published';

-- Faster per-article reaction counts (GROUP BY reaction_type).
CREATE INDEX IF NOT EXISTS idx_news_reactions_article_type
  ON news_reactions(article_id, reaction_type);

-- Used by lib/news/repository.countArticlesPublishedToday() to enforce the
-- daily AI-generation cap in lib/news/rss-ingester.ts.
CREATE INDEX IF NOT EXISTS idx_news_articles_created_at
  ON news_articles(created_at);

-- Track which news_sources row produced a given raw item, and when a source
-- was last polled — the ingester now reads active sources from this table
-- instead of a hardcoded list.
ALTER TABLE news_raw_items
  ADD COLUMN IF NOT EXISTS category_hint text;

COMMIT;
