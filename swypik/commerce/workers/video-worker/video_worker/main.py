from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time

from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from .ai_hooks import AzureAnalysisHook
from .azure_ai import AzureAISettings
from .config import Settings
from .db import PostgresRepository
from .ffmpeg_tools import FfmpegTranscoder
from .models import VideoJob
from .pg_queue import PostgresQueue
from .pg_runner import PostgresJobRunner, ShutdownController
from .redis_queue import QueueUnavailableError, RedisQueue
from .sound_mix import SoundMixer
from .storage import S3Storage
from .wakeup import Wakeup
from .worker import VideoProcessor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Swypik video processing worker")
    parser.add_argument("--once", action="store_true", help="Process one job and exit")
    parser.add_argument("--job-json", help="Process one inline JSON job payload instead of the queue")
    parser.add_argument("--stats", action="store_true", help="Print Postgres queue counts as JSON and exit")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    postgres_queue = settings.queue_backend == "postgres" and not args.job_json

    if (postgres_queue or args.stats) and not settings.database_url:
        logging.error(
            "VIDEO_QUEUE_BACKEND=postgres (default) needs DATABASE_URL; "
            "set it or use VIDEO_QUEUE_BACKEND=stream|list"
        )
        return 2

    # Cu lease owner, scrierile pe rândul jobului sunt protejate de `locked_by`.
    repository = PostgresRepository(settings, lease_owner=settings.worker_id if postgres_queue else None)

    if args.stats:
        print(json.dumps(PostgresQueue(settings, repository).stats(), sort_keys=True))
        return 0

    # Subtitrări (Whisper) + moderarea thumbnail-ului (Content Safety) pe Azure AI.
    ai_hook = AzureAnalysisHook(AzureAISettings.from_env(os.environ), repository)
    processor = VideoProcessor(
        settings,
        S3Storage(settings),
        FfmpegTranscoder(encoder=settings.video_encoder),
        repository,
        defer_transient=postgres_queue,
        analysis_hooks=[ai_hook] if ai_hook.enabled else [],
        # „Adaugă sunet”: mixul piesei alese (sound_mix.py), setările citite din DB.
        sound_mixer=SoundMixer(FfmpegTranscoder._default_runner),
    )

    if args.job_json:
        result = processor.process(VideoJob.from_payload(args.job_json))
        return 0 if result.ok else 1

    if postgres_queue:
        return run_postgres(settings, repository, processor, once=args.once)
    return run_redis(settings, processor, once=args.once)


def run_postgres(settings: Settings, repository: PostgresRepository, processor: VideoProcessor, *, once: bool) -> int:
    logging.info(
        "Video worker %s on Postgres queue (lease %ss, poll %ss, shutdown=%s)",
        settings.worker_id, settings.lease_seconds, settings.poll_interval_seconds, settings.shutdown_mode,
    )
    shutdown = ShutdownController(settings.shutdown_mode)
    shutdown.install()
    wakeup = Wakeup(settings)
    runner = PostgresJobRunner(
        settings, PostgresQueue(settings, repository), processor, shutdown=shutdown, wait=wakeup.wait
    )
    try:
        return runner.run(once=once)
    finally:
        wakeup.close()


def run_redis(settings: Settings, processor: VideoProcessor, *, once: bool) -> int:
    """Backend legacy (VIDEO_QUEUE_BACKEND=stream|list)."""
    queue = RedisQueue(settings)
    stop = _StopFlag()
    signal.signal(signal.SIGINT, stop.handle)
    signal.signal(signal.SIGTERM, stop.handle)

    # Reconnect backoff state — survives transient Redis blips without crashing.
    reconnect_attempts = 0
    max_backoff_seconds = 30

    iterations = 0
    while not stop.requested:
        iterations += 1
        # Cap stream length every ~50 iterations so XLEN doesn't grow unbounded
        # past acked entries (XACK alone doesn't shorten the stream).
        if iterations % 50 == 0:
            try:
                queue.trim(max_len=5000)
            except Exception:
                pass
        try:
            queued = queue.pop_message()
            reconnect_attempts = 0  # success → reset backoff
            if queued is None:
                if once:
                    return 0
                continue
            result = processor.process(queued.job)
            if result.ok:
                queue.ack(queued)
            else:
                queue.fail(queued, result.message)
            if once:
                return 0 if result.ok else 1
        except (RedisConnectionError, RedisTimeoutError) as exc:
            reconnect_attempts += 1
            backoff = min(2 ** min(reconnect_attempts, 5), max_backoff_seconds)
            logging.warning(
                "Redis connection lost (attempt %d): %s. Reconnecting in %ds…",
                reconnect_attempts,
                exc,
                backoff,
            )
            if once:
                return 2
            # Sleep with stop-flag awareness so SIGTERM still cuts through.
            slept = 0.0
            while slept < backoff and not stop.requested:
                time.sleep(0.5)
                slept += 0.5
            # Force the queue client to reconnect on next iteration.
            try:
                queue._client = None  # type: ignore[attr-defined]
                queue._stream_group_ready = False  # type: ignore[attr-defined]
            except Exception:
                pass
            continue
        except QueueUnavailableError as exc:
            logging.error("%s", exc)
            return 2
        except Exception as exc:  # noqa: BLE001
            # Unexpected error in the main loop: log and continue rather than
            # crash-loop. Individual job errors are already handled inside
            # processor.process() / queue.fail().
            logging.exception("Unexpected error in worker main loop: %s", exc)
            if once:
                return 1
            time.sleep(1)

    return 0


class _StopFlag:
    def __init__(self) -> None:
        self.requested = False

    def handle(self, *_args) -> None:
        self.requested = True


if __name__ == "__main__":
    sys.exit(main())
