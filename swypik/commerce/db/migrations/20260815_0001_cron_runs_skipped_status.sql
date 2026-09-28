-- P1-04: `runCron` capătă un mutex distribuit (pg_try_advisory_xact_lock).
-- Când o rulare e sărită pentru că alta o ține, o notăm în audit-trail cu
-- status 'skipped' — valoare care nu era permisă de CHECK-ul existent.
--
-- Idempotent: se poate rula de mai multe ori fără efect suplimentar.

ALTER TABLE public.cron_runs
    DROP CONSTRAINT IF EXISTS cron_runs_status_check;

ALTER TABLE public.cron_runs
    ADD CONSTRAINT cron_runs_status_check
    CHECK (status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text, 'skipped'::text]));

-- Interogările de alerting filtrează pe joburile care NU au reușit; indexul
-- parțial existent acoperă doar 'failed'. Sărituri repetate = simptom de job
-- care depășește fereastra de declanșare, deci merită să fie ieftin de găsit.
CREATE INDEX IF NOT EXISTS cron_runs_skipped_idx
    ON public.cron_runs (job_name, completed_at DESC)
    WHERE status = 'skipped';
