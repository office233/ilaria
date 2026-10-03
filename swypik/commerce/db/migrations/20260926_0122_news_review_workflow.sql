-- Swypik News: flux de publicare cu revizie opțională + ingestie idempotentă.
--  * articolele în așteptare folosesc statusul existent 'draft' (fără schimbare
--    de constrângere); se notează cine/când a revizuit;
--  * news_raw_items.attempts: o știre RSS a cărei generare a eșuat poate fi
--    reîncercată de un număr limitat de ori (claim atomic pe url UNIQUE);
--  * indexuri pentru coada de revizie din /admin/news și atribuirea surselor.
-- Nimic nu se șterge; idempotent.

ALTER TABLE news_articles
    ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE news_raw_items
    ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_news_articles_status_created
    ON news_articles (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_article_sources_article
    ON news_article_sources (article_id);
