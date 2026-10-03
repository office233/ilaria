-- Swypik News: sursele RSS inițiale nu aveau categorie (toate ajungeau în
-- „tech-ai”), iar categoriile business/science nu aveau nicio sursă în tabel.
-- Setăm categoria surselor existente și adăugăm fluxuri publice pentru
-- categoriile goale. Doar surse cu RSS public oficial; atribuirea + linkul
-- către articolul original apar pe fiecare știre. Idempotent.

UPDATE news_sources s
   SET category_id = c.id
  FROM news_categories c
 WHERE s.category_id IS NULL
   AND c.slug = CASE
         WHEN s.feed_url ILIKE '%techcrunch.com%' THEN 'tech-ai'
         WHEN s.feed_url ILIKE '%theverge.com%' THEN 'tech-ai'
         WHEN s.feed_url ILIKE '%feedburner.com/ign%' THEN 'gaming'
         ELSE NULL
       END;

INSERT INTO news_sources (name, website_url, feed_url, category_id, reliability_score, language_code)
SELECT v.name, v.website_url, v.feed_url, c.id, v.reliability, 'en'
  FROM (VALUES
          ('BBC Business', 'https://www.bbc.com/news/business', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'business', 0.95),
          ('BBC Science', 'https://www.bbc.com/news/science_and_environment', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'science', 0.95),
          ('ScienceDaily', 'https://www.sciencedaily.com', 'https://www.sciencedaily.com/rss/top/science.xml', 'science', 0.90)
       ) AS v(name, website_url, feed_url, category_slug, reliability)
  JOIN news_categories c ON c.slug = v.category_slug
ON CONFLICT (feed_url) DO NOTHING;
