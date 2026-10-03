/**
 * Coada de procesare video = tabela `video_processing_jobs` (Postgres).
 *
 * Decizie (docs/infra/stateless-checklist.md §5): Postgres `FOR UPDATE SKIP
 * LOCKED` în locul Redis Streams ca sursă de adevăr. Jobul e deja un rând
 * durabil, inserat în aceeași tranzacție cu clipul — coada Redis era o a doua
 * copie (dual-write: rând 'queued' fără mesaj în stream, re-publicare de
 * watchdog la 30 min). Acum workerii (N containere, orice host) revendică
 * direct din tabel, cu lease + heartbeat, reîncercări cu backoff
 * (`scheduled_at`) și dead-letter (`dead_lettered_at`). Redis rămâne doar un
 * semnal de trezire (pub/sub), opțional — fără el workerii fac polling la 2 s.
 *
 * `VIDEO_QUEUE_BACKEND=stream` păstrează comportamentul vechi (XADD) pentru
 * un rollback fără migrare inversă.
 */
import { dbQuery } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { publishRealtime, realtimeChannels } from "@/lib/realtime";

export type VideoQueueBackend = "postgres" | "stream" | "list";

export function videoQueueBackend(): VideoQueueBackend {
  const raw = (process.env.VIDEO_QUEUE_BACKEND || "postgres").trim().toLowerCase();
  return raw === "stream" || raw === "list" ? raw : "postgres";
}

/** Semnal de trezire pentru workerii inactivi. Best-effort: fără Redis, polling-ul îl preia. */
export async function wakeVideoWorkers(jobId: string): Promise<boolean> {
  return publishRealtime(realtimeChannels.videoWakeup, jobId);
}

export type VideoQueueMetrics = {
  queued: number;
  scheduled_retry: number;
  running: number;
  expired_leases: number;
  dead_letter: number;
  failed_24h: number;
  succeeded_24h: number;
  active_workers: number;
  oldest_queued_age_s: number;
};

const METRIC_KEYS: (keyof VideoQueueMetrics)[] = [
  "queued",
  "scheduled_retry",
  "running",
  "expired_leases",
  "dead_letter",
  "failed_24h",
  "succeeded_24h",
  "active_workers",
  "oldest_queued_age_s",
];

export async function getVideoQueueMetrics(): Promise<VideoQueueMetrics> {
  const { rows } = await dbQuery<Record<keyof VideoQueueMetrics, number | string | null>>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued' AND scheduled_at <= NOW())::int AS queued,
       COUNT(*) FILTER (WHERE status = 'queued' AND scheduled_at > NOW())::int AS scheduled_retry,
       COUNT(*) FILTER (WHERE status = 'running' AND COALESCE(lease_expires_at, NOW()) >= NOW())::int AS running,
       COUNT(*) FILTER (WHERE status = 'running' AND lease_expires_at < NOW())::int AS expired_leases,
       COUNT(*) FILTER (WHERE status = 'failed' AND dead_lettered_at IS NOT NULL)::int AS dead_letter,
       COUNT(*) FILTER (WHERE status = 'failed' AND completed_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
       COUNT(*) FILTER (WHERE status = 'succeeded' AND completed_at > NOW() - INTERVAL '24 hours')::int AS succeeded_24h,
       COUNT(DISTINCT locked_by) FILTER (WHERE status = 'running' AND lease_expires_at >= NOW())::int AS active_workers,
       COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(scheduled_at)
         FILTER (WHERE status = 'queued' AND scheduled_at <= NOW())), 0)::int AS oldest_queued_age_s
     FROM video_processing_jobs
     WHERE job_type = 'transcode'
       AND (status IN ('queued', 'running')
            OR completed_at > NOW() - INTERVAL '24 hours'
            OR dead_lettered_at IS NOT NULL)`,
  );
  const row = rows[0] ?? {};
  const out = {} as VideoQueueMetrics;
  for (const key of METRIC_KEYS) out[key] = Number((row as Record<string, unknown>)[key] ?? 0) || 0;
  return out;
}

export type DeadLetterJob = {
  id: string;
  video_id: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  dead_lettered_at: string;
};

export async function listDeadLetters(limit = 50): Promise<DeadLetterJob[]> {
  const { rows } = await dbQuery<DeadLetterJob>(
    `SELECT id, video_id, attempt_count, error_code, error_message, dead_lettered_at
       FROM video_processing_jobs
      WHERE status = 'failed' AND dead_lettered_at IS NOT NULL
      ORDER BY dead_lettered_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

/**
 * Reia un job din dead-letter (acțiune admin). Respectă indexul unic „un job
 * activ per clip”: dacă între timp există altul activ, nu face nimic.
 */
export async function requeueDeadLetter(jobId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string; video_id: string }>(
    `UPDATE video_processing_jobs j
        SET status = 'queued', attempt_count = 0, scheduled_at = NOW(), dead_lettered_at = NULL,
            completed_at = NULL, locked_by = NULL, lease_expires_at = NULL, stage = 'queued',
            progress = 0, error_code = NULL, error_message = NULL, updated_at = NOW()
      WHERE j.id = $1 AND j.status = 'failed' AND j.dead_lettered_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM video_processing_jobs o
           WHERE o.video_id = j.video_id AND o.id <> j.id AND o.job_type = 'transcode'
             AND o.status IN ('queued', 'running'))
      RETURNING j.id, j.video_id`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return false;
  await dbQuery(
    `UPDATE videos SET status = 'processing', updated_at = NOW() WHERE id = $1 AND status = 'failed'`,
    [row.video_id],
  );
  await wakeVideoWorkers(row.id);
  return true;
}

/**
 * Menaj pentru watchdog (workerii fac același lucru înainte de revendicare):
 * joburile fără încercări rămase — lease expirat (worker mort la ultima
 * încercare) sau rămase 'queued' peste buget (moștenite de la workerul vechi,
 * pe care revendicarea nu le mai ia) — trec în dead-letter. Cele cu încercări
 * rămase sunt revendicate direct de următorul worker liber, deci nu le atingem.
 * Joburile vechi fără lease folosesc `updated_at` + `staleMinutes`.
 */
export async function reapExhaustedJobs(staleMinutes: number): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE video_processing_jobs
        SET status = 'failed', completed_at = NOW(), dead_lettered_at = NOW(),
            error_code = COALESCE(NULLIF(error_code, ''), 'max_attempts'),
            error_message = COALESCE(NULLIF(error_message, ''), 'retry budget exhausted'),
            locked_by = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE job_type = 'transcode'
        AND attempt_count >= max_attempts
        AND (status = 'queued'
             OR (status = 'running'
                 AND COALESCE(lease_expires_at, updated_at + ($1::int * INTERVAL '1 minute')) < NOW()))`,
    [staleMinutes],
  );
  return rowCount ?? 0;
}

/**
 * Go `platform-api` încă face XADD în streamul vechi `video:jobs`. Cu coada în
 * Postgres nimeni nu-l mai consumă, deci îl ținem mărginit (apelat de watchdog).
 */
export async function trimLegacyVideoStream(maxLen = 1000): Promise<number> {
  if (!process.env.REDIS_URL) return 0;
  const stream = process.env.VIDEO_QUEUE_NAME || process.env.REDIS_STREAM_VIDEO_JOBS || "video:jobs";
  try {
    return await getRedis().xtrim(stream, "MAXLEN", "~", maxLen);
  } catch {
    return 0;
  }
}
