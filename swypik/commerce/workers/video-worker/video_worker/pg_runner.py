"""Bucla workerului pe coada Postgres: reap → claim → heartbeat → process →
succes / retry cu backoff / dead letter; eliberare la oprire grațioasă."""
from __future__ import annotations

import logging
import random
import signal
import time
from pathlib import Path
from typing import Callable

from .config import Settings
from .errors import ShutdownRequested
from .lease import LeaseHeartbeat, retry_backoff
from .pg_queue import ClaimedJob, PostgresQueue
from .worker import ProcessResult, VideoProcessor

logger = logging.getLogger(__name__)

#: Reap-ul lease-urilor expirate rulează înainte de claim, cel mult o dată la 30 s.
REAP_INTERVAL_SECONDS = 30.0


class ShutdownController:
    """SIGTERM/SIGINT.

    - inactiv → doar steagul; bucla iese la următoarea iterație;
    - job în curs + mode `release` → ridică ShutdownRequested (BaseException) din
      handler; `subprocess.run` omoară ffmpeg la ieșire, bucla eliberează jobul;
    - mode `finish` → doar steagul, jobul curent se termină;
    - al doilea semnal (inclusiv în timpul eliberării) → ignorat.
    """

    def __init__(self, mode: str = "release") -> None:
        self.mode = mode
        self.requested = False
        self.busy = False

    def handle(self, signum=None, _frame=None) -> None:
        if self.requested:
            logger.info("Shutdown already in progress; ignoring signal %s", signum)
            return
        self.requested = True
        logger.info("Shutdown requested (signal %s, mode=%s, busy=%s)", signum, self.mode, self.busy)
        if self.busy and self.mode == "release":
            raise ShutdownRequested()

    def install(self) -> None:
        signal.signal(signal.SIGINT, self.handle)
        signal.signal(signal.SIGTERM, self.handle)


class PostgresJobRunner:
    def __init__(
        self,
        settings: Settings,
        queue: PostgresQueue,
        processor: VideoProcessor,
        *,
        shutdown: ShutdownController | None = None,
        wait: Callable[[float], object] | None = None,
        clock: Callable[[], float] = time.monotonic,
        rand: Callable[[], float] = random.random,
        heartbeat_interval: float | None = None,
    ) -> None:
        self.settings = settings
        self.queue = queue
        self.processor = processor
        self.shutdown = shutdown or ShutdownController(settings.shutdown_mode)
        self._wait = wait or time.sleep
        self._clock = clock
        self._rand = rand
        self.heartbeat_interval = heartbeat_interval or settings.heartbeat_interval_seconds
        self._last_reap: float | None = None
        self.last_result: ProcessResult | None = None

    def run(self, *, once: bool = False) -> int:
        while not self.shutdown.requested:
            self.touch_heartbeat_file()
            try:
                handled = self.run_once()
            except ShutdownRequested:
                logger.info("Worker stopped during a job; job released back to the queue")
                return 0
            except Exception:  # noqa: BLE001 - bucla nu are voie să cadă
                logger.exception("Unexpected error in postgres worker loop")
                if once:
                    return 1
                self._wait(1.0)
                continue
            if once:
                return 0 if self.last_result is None or self.last_result.ok else 1
            if not handled:
                self._wait(self.settings.poll_interval_seconds)
        logger.info("Worker stopped (idle)")
        return 0

    def run_once(self) -> bool:
        """Un ciclu; True dacă a fost revendicat un job (→ fără pauză)."""
        self.last_result = None
        self._maybe_reap()
        claimed = self.queue.claim()
        if claimed is None:
            return False
        if self.shutdown.requested:
            self._release(claimed)
            return True
        logger.info("Claimed job %s (attempt %d/%d)", claimed.job_id, claimed.attempt_count, claimed.max_attempts)
        self.shutdown.busy = True
        try:
            with LeaseHeartbeat(
                lambda: self._beat(claimed), self.heartbeat_interval, name=f"lease-{claimed.job_id}"
            ) as lease:
                result = self.processor.process(claimed.job)
        except ShutdownRequested:
            self.shutdown.busy = False
            self._release(claimed)
            raise
        finally:
            self.shutdown.busy = False
        if lease.lost:
            logger.warning("Job %s finished after its lease was lost; final writes are fenced", claimed.job_id)
        self.last_result = result
        self._finish(claimed, result)
        return True

    def _finish(self, claimed: ClaimedJob, result: ProcessResult) -> None:
        if result.ok:
            logger.info("Job %s succeeded", claimed.job_id)
            return
        details = dict(result.details or {})
        if not details.get("transient"):
            return  # eroare permanentă: procesorul a marcat deja jobul failed (fără dead letter)
        code = str(details.get("error_code") or "internal_error")
        if claimed.attempts_left:
            delay = retry_backoff(
                claimed.attempt_count,
                self.settings.retry_backoff_seconds,
                self.settings.retry_backoff_max_seconds,
                self._rand,
            )
            if self.queue.retry(claimed.job_id, delay, code, result.message):
                logger.warning(
                    "Job %s attempt %d/%d failed (%s); retry in %.1fs",
                    claimed.job_id, claimed.attempt_count, claimed.max_attempts, code, delay,
                )
            else:
                logger.warning("Job %s: retry skipped, lease no longer owned by this worker", claimed.job_id)
            return
        logger.error("Job %s exhausted %d attempts (%s); dead-lettering", claimed.job_id, claimed.max_attempts, code)
        self.queue.repository.mark_failed(claimed.job, result.message, error_code=code, dead_letter=True)

    def _release(self, claimed: ClaimedJob) -> None:
        try:
            released = self.queue.release(claimed.job_id)
            logger.info("Job %s released back to the queue (%s)", claimed.job_id, "ok" if released else "not owned")
        except Exception:  # noqa: BLE001 - lease-ul expiră oricum
            logger.exception("Could not release job %s; its lease will expire", claimed.job_id)

    def _beat(self, claimed: ClaimedJob) -> bool:
        self.touch_heartbeat_file()
        return self.queue.heartbeat(claimed.job_id)

    def _maybe_reap(self) -> None:
        now = self._clock()
        if self._last_reap is not None and now - self._last_reap < REAP_INTERVAL_SECONDS:
            return
        self._last_reap = now
        try:
            self.queue.reap_expired()
        except Exception:  # noqa: BLE001
            logger.exception("Reaping expired leases failed")

    def touch_heartbeat_file(self) -> None:
        """Healthcheck-ul docker verifică vârsta acestui fișier (buclă + lease heartbeat)."""
        path = Path(self.settings.heartbeat_file)
        try:
            path.write_text(f"{time.time():.0f}\n", encoding="utf-8")
        except OSError:
            logger.debug("Could not write heartbeat file %s", path)
