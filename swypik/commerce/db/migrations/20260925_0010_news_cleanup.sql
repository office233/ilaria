-- Curățenie Swypik News (2026-09-25):
--  1. categoria "crypto" și sursele ei (CoinDesk, CoinTelegraph) sunt retrase
--     (eliminarea completă a crypto din produs, eligibilitate NVIDIA Inception);
--  2. articolele fabricate publicate de versiunea anterioară a pipeline-ului sunt
--     arhivate: subiectele „curatoriate” inventate (URL-uri inexistente) și
--     articolele generate din șablonul de fallback când AI-ul nu era disponibil.
-- Nimic nu se șterge; totul e idempotent.

UPDATE news_categories SET is_active = false WHERE slug = 'crypto';

UPDATE news_sources
   SET is_active = false
 WHERE category_id IN (SELECT id FROM news_categories WHERE slug = 'crypto')
    OR feed_url ILIKE '%coindesk.com%'
    OR feed_url ILIKE '%cointelegraph.com%';

UPDATE news_articles
   SET status = 'archived', updated_at = now()
 WHERE status <> 'archived'
   AND category_id IN (SELECT id FROM news_categories WHERE slug = 'crypto');

UPDATE news_articles a
   SET status = 'archived', updated_at = now()
 WHERE a.status <> 'archived'
   AND (
         a.fact_check_notes LIKE 'Verificat și coroborat în timp real cu dispeceratul de știri %'
      OR EXISTS (
           SELECT 1 FROM news_article_sources s
            WHERE s.article_id = a.id
              AND s.original_url IN (
                'https://techcrunch.com/ai-realtime-breakthrough-2026',
                'https://news.ycombinator.com/item?id=ai-open-evals-2026',
                'https://coindesk.com/btc-etf-institutional-flows-record',
                'https://cointelegraph.com/news/ethereum-l2-volume-record-2026',
                'https://ign.com/next-gen-webgpu-triple-a',
                'https://pcgamer.com/unreal-engine-neural-procedural',
                'https://bloomberg.com/social-commerce-boom-europe',
                'https://forbes.com/business-blockchain-settlement-banks',
                'https://sciencedaily.com/jwst-biosignatures-discovery-2026',
                'https://nature.com/articles/fusion-net-energy-milestone'
              )
         )
   );
