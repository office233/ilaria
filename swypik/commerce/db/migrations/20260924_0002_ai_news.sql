-- 20260924_0002_ai_news.sql
-- Swypik AI News Module Schema: Autonomous AI Journalist, Categories, Fact-Checking

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Categorii de Știri
CREATE TABLE IF NOT EXISTS news_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  icon text,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO news_categories (slug, name, icon, display_order) VALUES
  ('tech-ai', 'Tehnologie & AI', 'cpu', 1),
  ('crypto', 'Crypto & Web3', 'coins', 2),
  ('gaming', 'Gaming & Pop Culture', 'gamepad-2', 3),
  ('business', 'Business & Startups', 'trending-up', 4),
  ('science', 'Știință & Spațiu', 'atom', 5)
ON CONFLICT (slug) DO NOTHING;

-- 2. Surse de Încredere Monitorizate (RSS)
CREATE TABLE IF NOT EXISTS news_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  website_url text NOT NULL,
  feed_url text NOT NULL UNIQUE,
  category_id uuid REFERENCES news_categories(id) ON DELETE SET NULL,
  reliability_score numeric(3,2) NOT NULL DEFAULT 0.90,
  language_code text NOT NULL DEFAULT 'en',
  fetch_interval_minutes int NOT NULL DEFAULT 15,
  is_active boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO news_sources (name, website_url, feed_url, reliability_score) VALUES
  ('TechCrunch', 'https://techcrunch.com', 'https://techcrunch.com/feed/', 0.95),
  ('The Verge', 'https://theverge.com', 'https://www.theverge.com/rss/index.xml', 0.95),
  ('CoinDesk', 'https://coindesk.com', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 0.90),
  ('CoinTelegraph', 'https://cointelegraph.com', 'https://cointelegraph.com/rss', 0.88),
  ('IGN', 'https://ign.com', 'https://feeds.feedburner.com/ign/all', 0.92)
ON CONFLICT (feed_url) DO NOTHING;

-- 3. Articole Brute Ingerate
CREATE TABLE IF NOT EXISTS news_raw_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES news_sources(id) ON DELETE CASCADE,
  external_id text,
  url text NOT NULL UNIQUE,
  title text NOT NULL,
  raw_content text,
  author text,
  published_at timestamptz,
  is_processed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_raw_items_unprocessed ON news_raw_items(is_processed, created_at DESC);

-- 4. Articole Finale Generate Autonom de AI
CREATE TABLE IF NOT EXISTS news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  category_id uuid NOT NULL REFERENCES news_categories(id) ON DELETE RESTRICT,
  title text NOT NULL,
  summary_tldr text NOT NULL,
  content_markdown text NOT NULL,
  cover_image_url text NOT NULL,
  cover_image_caption text,
  cover_image_author text,
  is_breaking boolean NOT NULL DEFAULT false,
  is_trending boolean NOT NULL DEFAULT false,
  reading_time_minutes int NOT NULL DEFAULT 3,
  view_count bigint NOT NULL DEFAULT 0,
  ai_model_name text NOT NULL DEFAULT 'gemini-1.5-pro',
  fact_check_score int NOT NULL DEFAULT 95 CHECK (fact_check_score BETWEEN 0 AND 100),
  fact_check_notes text,
  ai_disclaimer text NOT NULL DEFAULT 'Acest articol a fost redactat și sintetizat în mod autonom de către AI-ul Swypik pe baza surselor verificate menționate. Informațiile sunt supuse verificării factuale continue.',
  search_vector tsvector,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_articles_published ON news_articles(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_category ON news_articles(category_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_breaking ON news_articles(is_breaking, published_at DESC) WHERE is_breaking = true;
CREATE INDEX IF NOT EXISTS idx_news_articles_trending ON news_articles(view_count DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_search ON news_articles USING gin(search_vector);

-- 5. Relația între Articolul AI și Sursele Originale
CREATE TABLE IF NOT EXISTS news_article_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  source_id uuid REFERENCES news_sources(id) ON DELETE SET NULL,
  original_url text NOT NULL,
  original_title text,
  relevance_weight numeric(3,2) DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 6. Reacții Utilizatori la Știri
CREATE TABLE IF NOT EXISTS news_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id text,
  reaction_type text NOT NULL CHECK (reaction_type IN ('fire', 'insightful', 'mindblown', 'rocket', 'skeptical')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_news_reaction UNIQUE (article_id, user_id, reaction_type)
);

-- 7. Comentarii la Știri
CREATE TABLE IF NOT EXISTS news_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(content) >= 2 AND length(content) <= 2000),
  parent_id uuid REFERENCES news_comments(id) ON DELETE CASCADE,
  likes_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'moderated', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Trigger căutare Full-Text
CREATE OR REPLACE FUNCTION news_articles_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary_tldr, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.content_markdown, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_news_articles_search_update ON news_articles;
CREATE TRIGGER trg_news_articles_search_update
  BEFORE INSERT OR UPDATE OF title, summary_tldr, content_markdown
  ON news_articles
  FOR EACH ROW
  EXECUTE FUNCTION news_articles_search_update();

COMMIT;
