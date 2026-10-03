-- 20260927_0010_video_job_queue_lease
--
-- Coada de procesare video devine o coadă „competing consumers” în Postgres
-- (vezi docs/infra/stateless-checklist.md §5):
--   * workerii (N containere, pe orice host) revendică joburile cu
--     `SELECT … FOR UPDATE SKIP LOCKED` — niciun job nu e luat de doi workeri;
--   * `locked_by` + `lease_expires_at` = lease; workerul îl prelungește prin
--     heartbeat (`heartbeat_at`). Un worker mort → lease-ul expiră → alt worker
--     reia jobul (fără watchdog de 30 de minute);
--   * reîncercări cu backoff: jobul revine în 'queued' cu `scheduled_at` în viitor;
--   * dead-letter: `status='failed'` + `dead_lettered_at` (reîncercările
--     tranzitorii s-au epuizat) — vizibil în /api/admin/video-queue, reluabil manual.
--
-- Nu se schimbă constrângeri existente și nu se șterge nimic. Idempotent.

BEGIN;

ALTER TABLE video_processing_jobs
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

-- Revendicarea: cel mai prioritar job 'queued' scadent.
CREATE INDEX IF NOT EXISTS video_processing_jobs_claim_idx
  ON video_processing_jobs (priority DESC, scheduled_at)
  WHERE status = 'queued' AND job_type = 'transcode';

-- Lease-uri expirate (worker mort) — reluate la revendicare / de watchdog.
CREATE INDEX IF NOT EXISTS video_processing_jobs_lease_idx
  ON video_processing_jobs (lease_expires_at)
  WHERE status = 'running';

-- Dead-letter (vedere admin + alerte).
CREATE INDEX IF NOT EXISTS video_processing_jobs_dead_letter_idx
  ON video_processing_jobs (dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

-- Joburile 'running' preluate de workerul vechi (fără lease) primesc un lease
-- derivat din ultimul heartbeat, ca să poată fi reluate dacă workerul a murit.
UPDATE video_processing_jobs
   SET lease_expires_at = COALESCE(updated_at, NOW()) + INTERVAL '30 minutes'
 WHERE status = 'running' AND lease_expires_at IS NULL;

COMMIT;
