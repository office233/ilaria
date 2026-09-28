"""Coada video = tabelul `video_processing_jobs` (competing consumers în Postgres).

De ce Postgres și nu Redis Streams: jobul e deja un rând durabil, inserat în
aceeași tranzacție cu videoul (Next.js + Go platform-api). Streamul Redis era o
a doua copie → drift (job în DB dar XADD eșuat, intrări fără rând, watchdog de
30 min). Aici: revendicare `FOR UPDATE SKIP LOCKED`, lease + heartbeat, retry cu
backoff prin `scheduled_at`, dead-letter prin `dead_lettered_at`. Redis e doar un
semnal opțional de trezire (vezi wakeup.py), niciodată sursa de adevăr.
Schema: db/migrations/20260927_0010_video_job_queue_lease.sql.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Mapping

from .config import Settings
from .db import PostgresRepository, _format_table
from .models import InvalidJobPayload, VideoJob

logger = logging.getLogger(__name__)

CLAIM_SQL = """
WITH next AS (
  SELECT id FROM {jobs}
   WHERE job_type = 'transcode'
     AND attempt_count < max_attempts
     AND ((status = 'queued' AND scheduled_at <= NOW())
       OR (status = 'running' AND lease_expires_at < NOW()))
   ORDER BY priority DESC, scheduled_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED)
UPDATE {jobs} j
   SET status = 'running', locked_by = %s,
       lease_expires_at = NOW() + make_interval(secs => %s),
       heartbeat_at = NOW(), started_at = NOW(),
       attempt_count = j.attempt_count + 1, updated_at = NOW()
  FROM next WHERE j.id = next.id
RETURNING j.id, j.video_id, j.asset_id, j.payload, j.attempt_count, j.max_attempts, j.source_url
"""

REAP_SQL = """
UPDATE {jobs} SET status='failed', completed_at=NOW(), dead_lettered_at=NOW(),
       error_code = COALESCE(NULLIF(error_code,''), 'lease_expired'),
       error_message = COALESCE(NULLIF(error_message,''), 'lease expired after last attempt'),
       locked_by=NULL, lease_expires_at=NULL, updated_at=NOW()
 WHERE status='running' AND lease_expires_at < NOW() AND attempt_count >= max_attempts
RETURNING id
"""

HEARTBEAT_SQL = """
UPDATE {jobs} SET heartbeat_at=NOW(), updated_at=NOW(), lease_expires_at = NOW() + make_interval(secs => %s)
 WHERE id=%s AND locked_by=%s AND status='running' RETURNING id
"""

RETRY_SQL = """
UPDATE {jobs} SET status='queued', scheduled_at = NOW() + make_interval(secs => %s),
       locked_by=NULL, lease_expires_at=NULL, stage='retrying', error_code=%s, error_message=%s, updated_at=NOW()
 WHERE id=%s AND locked_by=%s AND status='running'
"""

RELEASE_SQL = """
UPDATE {jobs} SET status='queued', attempt_count = GREATEST(attempt_count - 1, 0), scheduled_at=NOW(),
       locked_by=NULL, lease_expires_at=NULL, stage='queued', updated_at=NOW()
 WHERE id=%s AND locked_by=%s AND status='running'
"""

STATS_SQL = """
SELECT
  COUNT(*) FILTER (WHERE status = 'queued' AND scheduled_at <= NOW()) AS queued,
  COUNT(*) FILTER (WHERE status = 'queued' AND scheduled_at > NOW()) AS scheduled_retry,
  COUNT(*) FILTER (WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at >= NOW())) AS running,
  COUNT(*) FILTER (WHERE status = 'running' AND lease_expires_at < NOW()) AS expired_leases,
  COUNT(*) FILTER (WHERE status = 'failed' AND dead_lettered_at IS NOT NULL) AS dead_letter,
  COUNT(*) FILTER (WHERE status = 'failed' AND completed_at > NOW() - INTERVAL '24 hours') AS failed_24h,
  COUNT(*) FILTER (WHERE status = 'succeeded' AND completed_at > NOW() - INTERVAL '24 hours') AS succeeded_24h,
  COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(scheduled_at)
    FILTER (WHERE status = 'queued' AND scheduled_at <= NOW())), 0)::bigint AS oldest_queued_age_s
FROM {jobs}
WHERE job_type = 'transcode'
"""

STATS_KEYS = (
    "queued", "scheduled_retry", "running", "expired_leases",
    "dead_letter", "failed_24h", "succeeded_24h", "oldest_queued_age_s",
)

# Câte payload-uri invalide consecutive marcăm într-un singur claim() înainte să cedăm.
_MAX_INVALID_PER_CLAIM = 10

_KEYS = {
    "video_id": ("video_id", "videoId"),
    "asset_id": ("asset_id", "assetId", "video_asset_id", "videoAssetId"),
    "source_url": ("source_url", "sourceUrl", "external_url", "externalUrl"),
}


@dataclass(frozen=True)
class ClaimedJob:
    job: VideoJob
    attempt_count: int
    max_attempts: int

    @property
    def job_id(self) -> str:
        return self.job.job_id

    @property
    def attempts_left(self) -> bool:
        return self.attempt_count < self.max_attempts


class PostgresQueue:
    def __init__(self, settings: Settings, repository: PostgresRepository) -> None:
        self.settings = settings
        self.repository = repository
        self.worker_id = settings.worker_id

    def claim(self) -> ClaimedJob | None:
        """Revendică un job (sau None dacă nu e nimic scadent).

        Un payload invalid (ex. reprocess admin cu `{}`) → mark_failed
        `invalid_payload` și se încearcă următorul job; bucla nu cade niciodată.
        """
        for _ in range(_MAX_INVALID_PER_CLAIM):
            row = self._fetchone(CLAIM_SQL, (self.worker_id, self.settings.lease_seconds))
            if row is None:
                return None
            job_id, video_id, asset_id, payload, attempt_count, max_attempts, source_url = row
            try:
                job = build_job(job_id, video_id, asset_id, payload, source_url)
            except InvalidJobPayload as exc:
                logger.warning("Job %s has an invalid payload: %s", job_id, exc)
                fallback = VideoJob(
                    job_id=str(job_id), asset_id=str(asset_id or ""), source_key="", output_prefix="",
                    video_id=str(video_id) if video_id else None,
                )
                self.repository.mark_failed(fallback, str(exc), error_code="invalid_payload")
                continue
            return ClaimedJob(job=job, attempt_count=int(attempt_count or 1), max_attempts=int(max_attempts or 1))
        return None

    def reap_expired(self) -> list[str]:
        """Lease expirat + fără încercări rămase → dead letter."""
        rows = self._fetchall(REAP_SQL, ())
        ids = [str(row[0]) for row in rows]
        if ids:
            logger.warning("Dead-lettered %d job(s) with expired leases: %s", len(ids), ", ".join(ids))
        return ids

    def heartbeat(self, job_id: str) -> bool:
        return self._fetchone(HEARTBEAT_SQL, (self.settings.lease_seconds, job_id, self.worker_id)) is not None

    def retry(self, job_id: str, delay_seconds: float, error_code: str, message: str) -> bool:
        return self._execute(RETRY_SQL, (float(delay_seconds), error_code, message, job_id, self.worker_id)) > 0

    def release(self, job_id: str) -> bool:
        """Oprire grațioasă: jobul revine în coadă fără să consume o încercare."""
        return self._execute(RELEASE_SQL, (job_id, self.worker_id)) > 0

    def stats(self) -> dict[str, int]:
        row = self._fetchone(STATS_SQL, ())
        values = row or (0,) * len(STATS_KEYS)
        return {key: int(value or 0) for key, value in zip(STATS_KEYS, values)}

    def _sql(self, sql: str) -> str:
        return _format_table(sql.strip(), "jobs", self.settings.jobs_table)

    def _fetchone(self, sql: str, params: tuple[Any, ...]):
        with self.repository.cursor() as cursor:
            cursor.execute(self._sql(sql), params)
            return cursor.fetchone()

    def _fetchall(self, sql: str, params: tuple[Any, ...]) -> list:
        with self.repository.cursor() as cursor:
            cursor.execute(self._sql(sql), params)
            return list(cursor.fetchall() or [])

    def _execute(self, sql: str, params: tuple[Any, ...]) -> int:
        with self.repository.cursor() as cursor:
            cursor.execute(self._sql(sql), params)
            return int(getattr(cursor, "rowcount", 0) or 0)


def build_job(job_id: Any, video_id: Any, asset_id: Any, payload: Any, source_url: Any) -> VideoJob:
    """VideoJob din rândul revendicat: `job_id` = id-ul rândului (forțat);
    video_id/asset_id/source_url din rând când payload-ul nu le are."""
    data = _payload_dict(payload)
    data["job_id"] = str(job_id)
    for key, value in (("video_id", video_id), ("asset_id", asset_id), ("source_url", source_url)):
        if value not in (None, "") and not any(data.get(k) not in (None, "") for k in _KEYS[key]):
            data[key] = str(value)
    return VideoJob.from_payload(data)


def _payload_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8")
    if isinstance(payload, str):
        if not payload.strip():
            return {}
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise InvalidJobPayload("Video job payload must be valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise InvalidJobPayload("Video job payload must be a JSON object")
    return dict(payload)
