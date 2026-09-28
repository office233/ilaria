import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { publishProcessVideoJob } from "@/lib/video/redis-queue";
import type { ProcessVideoJobPayload } from "@/lib/video/upload-session";
import { timingSafeEqual } from "crypto";
import { notifyUser } from "@/lib/notifications/dispatch";
import { expireAbandonedUploads } from "@/lib/video/upload/expire";
import { reapExhaustedJobs, trimLegacyVideoStream, videoQueueBackend, wakeVideoWorkers } from "@/lib/queue/video-jobs";

export const dynamic = "force-dynamic";

const STALE_RUNNING_MIN = Number(process.env.VIDEO_WATCHDOG_STALE_RUNNING_MIN ?? 30);
const STALE_QUEUED_MIN = Number(process.env.VIDEO_WATCHDOG_STALE_QUEUED_MIN ?? 30);
const MAX_ATTEMPTS = Number(process.env.VIDEO_WATCHDOG_MAX_ATTEMPTS ?? 6);
const REENQUEUE_BATCH = Number(process.env.VIDEO_WATCHDOG_REENQUEUE_BATCH ?? 200);

async function authorize(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader?.replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    req.headers.get("cron-secret") ||
    req.headers.get("x-cron-token") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function runWatchdog() {
  const pgQueue = videoQueueBackend() === "postgres";
  // 0) Coada Postgres (implicită): lease-urile expirate sunt reluate direct de
  //    workeri la revendicare; aici doar mutăm în dead-letter joburile care și-au
  //    epuizat încercările (lib/queue/video-jobs.ts).
  const deadLettered = pgQueue ? await reapExhaustedJobs(STALE_RUNNING_MIN) : 0;
  const legacyStreamTrimmed = pgQueue ? await trimLegacyVideoStream() : 0;

  // 1) [doar coada Redis veche] Reset jobs that have been running too long back
  //    to queued so they get picked up again; bump attempt_count so we can stop
  //    them eventually. Cu lease-uri, un worker viu nu e „furat” niciodată.
  const resetRunning = pgQueue ? { rows: [] as { id: string }[], rowCount: 0 } : await dbQuery<{ id: string }>(
    `UPDATE video_processing_jobs
        SET status = 'queued',
            attempt_count = COALESCE(attempt_count, 0) + 1,
            started_at = NULL,
            updated_at = NOW(),
            error_code = 'stale_running',
            error_message = 'reset by watchdog after running > ' || $1::text || ' min'
      WHERE status = 'running'
        AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
      RETURNING id`,
    [STALE_RUNNING_MIN]
  );

  // 2) Fail jobs that exceeded the retry budget so they don't loop forever.
  const failedExceeded = await dbQuery<{ id: string }>(
    `UPDATE video_processing_jobs
        SET status = 'failed',
            updated_at = NOW(),
            completed_at = NOW(),
            error_code = COALESCE(NULLIF(error_code, ''), 'max_attempts'),
            error_message = COALESCE(NULLIF(error_message, ''), 'attempt_count >= ' || $1::text)
      WHERE status IN ('queued','running')
        AND COALESCE(attempt_count, 0) >= $1::int
      RETURNING id`,
    [MAX_ATTEMPTS]
  );

  // 3) Re-publish to Redis stream any queued jobs older than the threshold,
  //    using the persisted payload column. Workers dedup by job state at
  //    consume time, so duplicate stream entries are safe.
  const stale = await dbQuery<{ id: string; payload: ProcessVideoJobPayload | null }>(
    `SELECT id, payload
       FROM video_processing_jobs
      WHERE status = 'queued'
        AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
        AND COALESCE(attempt_count, 0) < $2::int
      ORDER BY priority DESC NULLS LAST, updated_at ASC
      LIMIT $3::int`,
    [STALE_QUEUED_MIN, MAX_ATTEMPTS, REENQUEUE_BATCH]
  );

  let reenqueued = 0;
  let reenqueueFailed = 0;
  // Coada Postgres: rândurile 'queued' SUNT coada — un singur semnal de trezire ajunge.
  if (pgQueue && stale.rows.length > 0 && (await wakeVideoWorkers("watchdog"))) reenqueued = stale.rows.length;
  for (const row of pgQueue ? [] : stale.rows) {
    const payload = row.payload;
    if (!payload || typeof payload !== "object" || !payload.video_id) {
      reenqueueFailed += 1;
      continue;
    }
    const result = await publishProcessVideoJob(payload as ProcessVideoJobPayload);
    if (result.queued) {
      reenqueued += 1;
      await dbQuery(
        `UPDATE video_processing_jobs SET updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
    } else {
      reenqueueFailed += 1;
    }
  }

  // 4) Mark `videos` rows failed only when their job is also definitively failed
  //    (max attempts exceeded or hard error). Without this guard a healthy backlog
  //    of `processing` videos waiting on workers gets falsely flipped to failed
  //    while their jobs are still legitimately `queued`/`running`.
  const recovered = await dbQuery<{ id: string }>(
    `UPDATE videos v
        SET status='failed',
            visibility='private',
            is_hidden=true,
            updated_at=NOW()
       FROM video_processing_jobs j
      WHERE j.video_id = v.id
        AND v.status IN ('processing','uploading')
        AND v.updated_at < NOW() - INTERVAL '60 minutes'
        AND j.status = 'failed'
      RETURNING v.id`
  );

  // 5) BUG 4 (2026-08-03): clipuri blocate in `uploading` FARA niciun job de
  //    procesare (userul a abandonat inainte de action=complete). Pasul 4 nu
  //    le prinde niciodata (JOIN pe jobs). Dupa 6h le marcam failed+hidden ca
  //    sa nu ramana carduri moarte in UI-ul proprietarului.
  const abandoned = await dbQuery<{ id: string }>(
    `UPDATE videos v
        SET status='failed',
            visibility='private',
            is_hidden=true,
            updated_at=NOW()
      WHERE v.status = 'uploading'
        AND v.created_at < NOW() - INTERVAL '6 hours'
        AND NOT EXISTS (SELECT 1 FROM video_processing_jobs j WHERE j.video_id = v.id)
        AND NOT EXISTS (
          SELECT 1 FROM video_upload_sessions s
           WHERE s.video_id = v.id AND s.status IN ('created','uploading') AND s.expires_at > NOW()
        )
      RETURNING v.id`
  );
  // Uploadurile multipart reluabile expirate: abort în bucket + draft 'failed'.
  const expiredUploads = await expireAbandonedUploads();

  return {
    queueBackend: pgQueue ? "postgres" : "stream",
    deadLettered,
    legacyStreamTrimmed,
    resetRunning: resetRunning.rowCount ?? resetRunning.rows.length,
    failedExceeded: failedExceeded.rowCount ?? failedExceeded.rows.length,
    candidatesReenqueue: stale.rows.length,
    reenqueued,
    reenqueueFailed,
    videosMarkedFailed: recovered.rowCount ?? recovered.rows.length,
    abandonedUploadsFailed: abandoned.rowCount ?? abandoned.rows.length,
    expiredUploads,
    creatorsNotified: await notifyCreatorsOnStatusChange(),
    ts: new Date().toISOString(),
  };
}

/**
 * Restanță audit 2026-08-10: creatorul nu afla niciodată că videoclipul e
 * gata sau a eșuat. Notificăm idempotent (NOT EXISTS pe notifications cu
 * același video) pentru clipurile care au trecut în ready/failed în ultimele
 * 24h. Tipul `upload_processed` există deja în CHECK constraint + dispatch.
 */
async function notifyCreatorsOnStatusChange(): Promise<number> {
  const { rows } = await dbQuery<{
    id: string; creator_id: string; status: string; title: string | null;
  }>(
    `SELECT v.id, v.creator_id, v.status, v.title
       FROM videos v
      WHERE v.status IN ('ready','failed')
        AND v.updated_at > NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.video_id = v.id
             AND n.notification_type IN ('upload_processed','system')
             AND n.metadata->>'watchdog_status' IS NOT NULL
        )
      LIMIT 50`,
  );
  let sent = 0;
  for (const v of rows) {
    const isReady = v.status === "ready";
    await notifyUser(v.creator_id, {
      type: isReady ? "upload_processed" : "system",
      targetType: "video",
      targetId: v.id,
      payload: {
        watchdog_status: v.status,
        title: isReady ? "Videoclipul tău este gata 🎬" : "Procesarea clipului a eșuat",
        body: isReady
          ? `„${v.title ?? "Clipul"}" e publicat și vizibil pe profil.`
          : `„${v.title ?? "Clipul"}" nu a putut fi procesat. Încearcă să-l reîncarci.`,
        url: isReady ? `/explore?v=${v.id}` : "/account",
      },
    }).catch(() => undefined);
    sent++;
  }
  return sent;
}

async function GET_impl(req: Request) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const res = await runCron("watchdog-videos", async () => {
    const summary = await runWatchdog();
    return NextResponse.json(summary);
  });
  return res ?? cronSkippedResponse("watchdog-videos");
}

async function POST_impl(req: Request) {
  return GET(req);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
