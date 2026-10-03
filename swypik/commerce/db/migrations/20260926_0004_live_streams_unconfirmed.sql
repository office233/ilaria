-- Live: streamurile marcate 'live' la creare, fără ca media serverul să fi
-- confirmat vreodată publicarea (started_at e setat DOAR de callback-ul
-- /api/internal/live/started), revin la 'scheduled' ca să dispară de pe /live
-- și din badge-ul LIVE (2026-09-26, w1-security; audit live #5).
-- Nu se șterge nimic. Idempotent.

UPDATE live_streams
   SET status = 'scheduled'
 WHERE status = 'live'
   AND started_at IS NULL;
