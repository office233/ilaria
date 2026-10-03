-- Arhivează articolele „seed” fabricate de o versiune timpurie a pipeline-ului de știri
-- (URL-uri inventate, semnătura „Articol sintetizat automat din fluxul …”), rămase
-- publicate după 20260925_0010. Nimic nu se șterge; idempotent.
UPDATE news_articles
   SET status = 'archived', updated_at = now()
 WHERE status <> 'archived'
   AND fact_check_notes LIKE 'Articol sintetizat automat din fluxul %';
