# Swypik Video Worker

Python worker for video processing jobs. The queue is the Postgres table `video_processing_jobs` itself
(competing consumers); Redis Streams / lists remain as legacy backends.

The worker:

- claims jobs from Postgres with `FOR UPDATE SKIP LOCKED`, holds a lease with a heartbeat, retries with backoff and dead-letters exhausted jobs (see [Queue](#queue));
- downloads the raw upload from R2/S3-compatible storage (or, for admin re-encodes, from an external `source_url`);
- probes it with `ffprobe` (display dimensions after rotation, duration, audio presence, codec);
- validates the (trimmed) duration against per-job or default limits;
- generates HLS renditions on a **short-side ladder** that keeps the source aspect ratio (true 9:16 for vertical clips, no padding, no upscaling), plus `preview.mp4`, `thumbnail.jpg` and, when the source has sound, `audio.m4a` (mono 16 kHz, for speech-to-text captions);
- uploads everything back to object storage;
- reports progress (`stage` + `progress`) and final status to Postgres when `DATABASE_URL` is configured;
- retries transient failures inline and records a stable `error_code` on failure;
- runs the Azure AI analysis hook (`video_worker/ai_hooks.py`) when configured: `audio.m4a` → Azure OpenAI Whisper → segments in `video_captions` (auto; a creator-edited track is never overwritten; WebVTT is served from the segments by `GET /api/videos/[id]/captions?format=vtt`), and `thumbnail.jpg` → Azure AI Content Safety → on review/block/unavailable an `image_ai` case in `moderation_cases` and `moderation_status='pending_review'`. The Whisper transcript also goes through Content Safety `text:analyze` (thresholds `CONTENT_SAFETY_TEXT_*`); review/block/unavailable → a `speech_ai` case + `pending_review`. The hook never fails the job.
- mixes the creator's chosen sound ("Add sound", `video_worker/sound_mix.py`): the track (`videos.audio_track_id`, only `is_active AND licensed_for_commercial`, https URL, ≤ 40 MB) and the settings in `videos.metadata.sound_mix` (volume / original volume in %, keep original, loop, track start) are read from the DB at transcode time; ffmpeg builds `mix.m4a` on the trimmed window (`amix … normalize=0`) and every rendition takes video from the source and audio from the mix. If the settings change while the job runs, the mix is redone (max 3 passes). `metadata.sound_mixed_key` records what was actually mixed (`none` = original audio); the web app compares it with the current settings and re-encodes a ready clip when they differ. A failed mix never fails the job — the clip keeps its original audio. When the original sound is replaced, no `audio.m4a` is produced (no captions from music).

## Azure AI (optional)

| env | meaning |
|---|---|
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_WHISPER_DEPLOYMENT` | Whisper (api-version 2024-06-01, 25 MB/file). `audio.m4a` is mono 16 kHz @ 48 kbps ≈ 0.36 MB/min, so any clip under ~69 min fits in one call. |
| `AZURE_CONTENT_SAFETY_ENDPOINT`, `AZURE_CONTENT_SAFETY_KEY` | image:analyze (api-version 2024-09-01, 4 MB) |
| `CONTENT_SAFETY_IMAGE_REVIEW_AT` / `_BLOCK_AT` | severity thresholds (default 2 / 4) |
| `CONTENT_SAFETY_TEXT_REVIEW_AT` / `_BLOCK_AT` | transcript thresholds (default 4 / 6, same as the web app) |
| `VIDEO_AUTO_CAPTIONS`, `VIDEO_IMAGE_MODERATION`, `VIDEO_SPEECH_MODERATION` | set `0` to disable each part (default on when configured; speech moderation needs the Whisper transcript) |

429/5xx are retried (3 attempts, honouring `Retry-After`, max 8 s wait); after that captions are skipped and the thumbnail is held for review.

## Queue

Default backend: `VIDEO_QUEUE_BACKEND=postgres`. Schema: `db/migrations/20260927_0010_video_job_queue_lease.sql`
(`locked_by`, `lease_expires_at`, `heartbeat_at`, `dead_lettered_at`).

**Why Postgres.** Jobs are already durable rows, inserted by Next.js and the Go platform-api in the same
transaction as the video row. Redis Streams was a second copy of the same fact, which drifted (job in the DB but
`XADD` failed, stream entries without a row, a 30-minute watchdog re-publishing). Now the table *is* the queue;
Redis is at most a wake-up signal and never the source of truth.

**Lifecycle.**

1. *Claim*: one `UPDATE … FROM (SELECT … ORDER BY priority DESC, scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED)`
   picks a `transcode` job that is `queued` and due (`scheduled_at <= NOW()`), or `running` with an expired lease,
   and has attempts left. It sets `status='running'`, `locked_by=<VIDEO_WORKER_ID>`, `lease_expires_at`,
   `heartbeat_at`, `started_at` and increments `attempt_count`. Two workers never get the same row.
   The job is built from `payload`; `job_id` is always the row id, and `video_id` / `asset_id` / `source_url` come
   from the row when the payload lacks them. An invalid or empty payload (e.g. an admin "reprocess" that inserts
   `{}`) fails the job with `error_code='invalid_payload'` and the loop moves on.
2. *Lease + heartbeat*: a background thread extends `lease_expires_at` by `VIDEO_LEASE_SECONDS` every
   `max(5, lease/3)` seconds for the **whole** job (download, probe, transcode, upload). A dead worker stops
   heartbeating, its lease expires and another worker re-claims the job. If the heartbeat finds the row no longer
   owned, the lease is marked lost and a warning is logged.
3. *Fencing*: every job-row write (`mark_processing`, progress, `mark_ready`, `mark_failed`) carries
   `AND (locked_by IS NULL OR locked_by = <worker id>)`; final writes also clear `locked_by` / `lease_expires_at`.
   If the job row is owned by someone else, the asset/video rows are not touched. Outputs go to deterministic keys
   (`output_prefix`), so a re-run after a lost lease overwrites the same objects.
4. *Retry*: a transient error with attempts left puts the job back to `queued` with
   `scheduled_at = NOW() + min(VIDEO_RETRY_BACKOFF_SECONDS * 2^(attempt-1), VIDEO_RETRY_BACKOFF_MAX_SECONDS) + 0..10% jitter`
   and `stage='retrying'`. The worker does not sleep inline; it moves on to the next job.
5. *Dead letter*: a transient error on the last attempt marks job/asset/video `failed` and sets
   `dead_lettered_at`. Running jobs whose lease expired after the last attempt are dead-lettered by a reaper
   (`error_code='lease_expired'`, at most every 30 s, before a claim). Permanent errors (see the table below) fail
   without dead-lettering, as before, so the creator can retry. `max_attempts` comes from the row (default 3).
6. *Idle*: when nothing is due the worker waits `VIDEO_POLL_INTERVAL_SECONDS`, or less if a message arrives on the
   Redis pub/sub channel `VIDEO_WAKEUP_CHANNEL` (optional; producers may `PUBLISH video:jobs:wakeup <job_id>` after
   the insert). Without `REDIS_URL`, or with Redis down, it simply polls.

**Scaling.** Run as many workers as you like, on any host: `docker compose up --scale video-worker=N`. Each
worker needs only `DATABASE_URL` and the S3/R2 credentials; Redis is optional. Worker ids default to
`hostname:pid:random6`, so they are unique across containers.

**Queue stats.** `python -m video_worker.main --stats` prints one JSON object: `queued`, `scheduled_retry`,
`running`, `expired_leases`, `dead_letter`, `failed_24h`, `succeeded_24h`, `oldest_queued_age_s`.

**Legacy backends.** `VIDEO_QUEUE_BACKEND=stream` (Redis Streams consumer group) and `list` (`BLPOP`) still work,
with the old behaviour: atomic `try_claim`, inline retries with sleeps, no lease or fencing.

## Shutdown

- `VIDEO_SHUTDOWN_MODE=release` (default): on SIGTERM/SIGINT an idle worker exits at once. A busy worker aborts
  the job (ffmpeg is killed as the `ShutdownRequested` exception unwinds), releases it back to the queue
  (`status='queued'`, `attempt_count` decremented, `scheduled_at=NOW()`), stops the heartbeat, cleans its temp dir
  and exits 0. Another worker picks the job up right away. A second signal during the release is ignored.
- `VIDEO_SHUTDOWN_MODE=finish`: the signal only sets the stop flag; the current job finishes first. In compose,
  `stop_grace_period` must then be longer than `FFMPEG_TIMEOUT_SECONDS`, or Docker will SIGKILL the worker (the
  lease then expires and the job is retried).

## Healthcheck

The worker writes the current Unix time to `VIDEO_HEARTBEAT_FILE` (default `/tmp/video-worker-heartbeat`) on
every loop iteration and on every lease heartbeat, so the file stays fresh during long jobs. A docker healthcheck
should fail when the file is older than a few lease intervals, e.g.:

```yaml
healthcheck:
  test: ["CMD-SHELL", "test $$(( $$(date +%s) - $$(cat /tmp/video-worker-heartbeat 2>/dev/null || echo 0) )) -lt 300"]
  interval: 30s
  retries: 3
```

## Job Payload

In Postgres mode the payload is the row's `payload` jsonb column (fields below). For the legacy stream backend,
add stream entries to `VIDEO_QUEUE_NAME`:

```powershell
redis-cli XADD video:jobs * job_id job_123 asset_id asset_456 source_key uploads/raw/product.mp4 output_prefix videos/asset_456 source_bucket raw-videos output_bucket processed-videos
```

The worker also accepts a single `payload` field containing JSON:

```json
{
  "job_type": "process_video",
  "job_id": "job_123",
  "video_id": "video_789",
  "asset_id": "asset_456",
  "source_key": "videos/raw/upload_1/camera.mov",
  "source_url": "",
  "output_prefix": "videos/hls/video_789",
  "source_bucket": "Swypik-raw-videos",
  "output_bucket": "Swypik-processed-videos",
  "limits": { "min_duration_ms": 1000, "max_duration_ms": 180000 },
  "trim": { "start_ms": 1500, "end_ms": 31500 },
  "thumbnail_time_ms": 2000,
  "metadata": { "language": "ro" }
}
```

- `source_url`: empty for normal creator uploads → the worker downloads `source_bucket`/`source_key` from storage. A non-empty http(s) URL (admin re-encode) is downloaded with SSRF protection and mirrored raw into storage under `source_key` (content type guessed from the file name).
- `limits` (optional): per-job duration limits; missing fields fall back to `VIDEO_MIN_DURATION_MS` / `VIDEO_MAX_DURATION_MS`. The max has a 500 ms tolerance.
- `trim` (optional): `start_ms` / `end_ms` in the source timeline. Applied to every output (`-ss` before `-i`, `-t` = effective duration). Limits are checked on the trimmed duration.
- `thumbnail_time_ms` (optional): poster time relative to the trimmed clip start; default `min(1000, duration/2)`.
- Invalid numbers in these optional fields are ignored (treated as absent).

`bucket` is still accepted as a shorthand for both buckets. `source_bucket` defaults to `S3_BUCKET`; `output_bucket` defaults to `VIDEO_OUTPUT_BUCKET` and then `S3_BUCKET`. `output_prefix` defaults to `videos/<asset_id>`. `thumbnail_key`, `preview_key` and `hls_master_key` are accepted for producer/DB compatibility.

## Renditions

`VIDEO_LADDER` (default `360:800k,540:1400k,720:2800k,1080:5000k`) lists `short_side:bitrate` rungs. Every rung whose short side is ≤ the source short side is produced; the long side keeps the source aspect ratio (rounded to an even number). A 1080x1920 upload yields 360x640, 540x960, 720x1280 and 1080x1920; a 1920x1080 upload yields the landscape equivalents; a 3:4 clip stays 3:4. A source smaller than the lowest rung gets a single rendition at its own (even) size. `VIDEO_VARIANTS` has been **removed**.

## Result, Progress, Retries

`video_processing_jobs.stage` goes `downloading` (5) → `probing` (12) → `transcoding` (15..85) → `uploading` (90) → `done` (100); `retrying` between attempts. Progress writes are best-effort.

On success the job `result` (and the `videos` row) gets `master_url`, `thumbnail_url`, `preview_url`, `audio_url` (or `null`), `duration_ms` (trimmed), `width`/`height` (source display size), `has_audio`, `orientation` (`vertical` / `landscape` / `square`) and `renditions`. A thumbnail chosen by the creator (`videos.metadata.cover_source = 'custom'`) is not overwritten.

Transient errors (storage/network) are retried: in Postgres mode through the queue (see [Queue](#queue)); in
the legacy stream/list modes and with `--job-json`, inline up to `VIDEO_MAX_ATTEMPTS` total attempts with backoff
`VIDEO_RETRY_BACKOFF_SECONDS * 2^(attempt-1)`. Permanent errors fail immediately. Error codes:

| code | retried | cause |
|---|---|---|
| `no_video_stream` | no | the file has no video track |
| `invalid_source` | no | unreadable file, missing duration or dimensions |
| `duration_too_short` / `duration_too_long` | no | trimmed duration outside limits |
| `transcode_failed` | no | ffmpeg exited with an error |
| `timeout` | no | ffmpeg exceeded `FFMPEG_TIMEOUT_SECONDS` |
| `worker_misconfigured` | no | ffmpeg/ffprobe/boto3/psycopg missing |
| `storage_error` | yes | S3/R2 or network failure |
| `internal_error` | yes | anything else |
| `invalid_payload` | no | Postgres mode: the row's `payload` cannot be turned into a job |
| `lease_expired` | no | Postgres mode: the lease expired after the last attempt (dead letter) |

A failed video is set to `status='failed'`; visibility is left to the DB trigger `enforce_video_public_safety`, so the creator can retry.

## Local Setup

```powershell
cd E:\Swypik\swypik\app\workers\video-worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
copy .env.example .env
python -m video_worker.main --once
python -m video_worker.main --stats
```

Install `ffmpeg` (which ships `ffprobe`) separately and ensure both are on `PATH`.

For a local one-off job:

```powershell
python -m video_worker.main --job-json '{"job_id":"local","asset_id":"asset_local","source_key":"uploads/raw/input.mp4","output_prefix":"videos/asset_local"}'
```

## Configuration

Use `.env.example` as the starting point. Important variables:

- `VIDEO_QUEUE_BACKEND`: `postgres` (default), or legacy `stream` / `list`. Anything else stops the worker at startup.
- `DATABASE_URL`: Postgres URL. **Required** for the `postgres` backend (the worker exits with code 2 without it); optional for `stream`/`list`/`--job-json`, where status updates are skipped when unset.
- `VIDEO_WORKER_ID`: lease owner id, default `hostname:pid:random6`.
- `VIDEO_LEASE_SECONDS` (default `120`): lease length; the heartbeat runs every `max(5, lease/3)` s.
- `VIDEO_POLL_INTERVAL_SECONDS` (default `2`): wait between empty claims.
- `VIDEO_WAKEUP_CHANNEL` (default `video:jobs:wakeup`): optional Redis pub/sub wake-up channel.
- `VIDEO_RETRY_BACKOFF_MAX_SECONDS` (default `900`): cap for the queue retry backoff.
- `VIDEO_HEARTBEAT_FILE` (default `/tmp/video-worker-heartbeat`): liveness file for the healthcheck.
- `VIDEO_SHUTDOWN_MODE`: `release` (default) or `finish`, see [Shutdown](#shutdown).
- `REDIS_URL`: Redis connection string: the job queue for `stream`/`list`, only the optional wake-up signal for `postgres`.
- `VIDEO_QUEUE_NAME`: stream or queue key, default `video:jobs`.
- `VIDEO_CONSUMER_GROUP`: Redis Streams consumer group, default `video-workers`.
- `VIDEO_CONSUMER_NAME`: consumer name, default host name.
- `VIDEO_FAILED_STREAM`: optional stream where failed message metadata is copied.
- `VIDEO_ACK_FAILED_JOBS`: set true to acknowledge failed stream jobs after writing `VIDEO_FAILED_STREAM`.
- `S3_BUCKET`, `VIDEO_OUTPUT_BUCKET`, `S3_ENDPOINT_URL`, `S3_PUBLIC_BASE_URL`: R2/S3 settings.
- `VIDEO_LADDER`: rendition ladder, `short_side:bitrate` comma-separated.
- `VIDEO_ENCODER`: `libx264` (default, CPU) or `h264_nvenc` (NVIDIA GPU). Any other value stops the worker at startup. NVENC needs an NVIDIA GPU, an ffmpeg built with `--enable-nvenc`, and GPU access in the container (NVIDIA Container Toolkit).
- `VIDEO_MIN_DURATION_MS` (default `1000`), `VIDEO_MAX_DURATION_MS` (default `180000`): default duration limits.
- `VIDEO_MAX_ATTEMPTS` (default `3`): inline retries (legacy backends / `--job-json`); in Postgres mode the row's `max_attempts` applies.
- `VIDEO_RETRY_BACKOFF_SECONDS` (default `5`): backoff base for both inline and queue retries.
- `FFMPEG_TIMEOUT_SECONDS` (default `900`): per-command ffmpeg budget.
- `VIDEO_WORK_DIR`: optional scratch directory.

## Tests

```powershell
cd E:\Swypik\swypik\app\workers\video-worker
python -m pytest
```

Tests use injected runners and fakes; ffmpeg, S3, Redis and Postgres are not needed.
