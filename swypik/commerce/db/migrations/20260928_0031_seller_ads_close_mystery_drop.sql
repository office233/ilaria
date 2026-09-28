-- Mystery Drop a fost scos din produs (2026-09): tipul de reclamă `mystery_drop`
-- nu mai e oferit. Campaniile vechi de acest tip se închid ('ended'); nimic nu se
-- șterge. Idempotent.
UPDATE seller_ads
   SET status = 'ended', updated_at = now()
 WHERE ad_type = 'mystery_drop'
   AND status <> 'ended';
