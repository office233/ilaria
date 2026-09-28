from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .models import VideoJob
from .pg_pool import DatabaseUnavailableError, PooledConnections

__all__ = ["DatabaseUnavailableError", "PostgresRepository"]

logger = logging.getLogger(__name__)

# Fencing: doar deținătorul lease-ului (sau un job fără lease) poate scrie rândul.
_FENCE_SQL = " AND (locked_by IS NULL OR locked_by = %s)"


class PostgresRepository(PooledConnections):
    def __init__(self, settings: Settings, lease_owner: str | None = None) -> None:
        self.settings = settings
        # Setat doar pentru backend-ul postgres (= worker_id). Fără el (stream/
        # list/--job-json) SQL-ul rămâne cel vechi, fără gardă `locked_by`.
        self.lease_owner = lease_owner
        self._init_pool()

    @property
    def database_url(self) -> str | None:
        return self.settings.database_url

    def try_claim(self, job: VideoJob) -> bool:
        """Atomically claim a job: flip status queued->running only if still queued.

        Returns True if THIS worker won the claim (proceed to process), False if
        another worker / a watchdog requeue / a manual flip already moved the job
        out of 'queued'. The False path lets main.py ack the redis message and
        skip processing, eliminating duplicate work that was causing the
        ~150%% CPU + GB-egress runaway in 2026-05-20.
        """
        if not self.settings.database_url:
            return True
        with self.cursor() as cursor:
            cursor.execute(
                _format_table(
                    "UPDATE {jobs} SET status='running', started_at=NOW(), "
                    "attempt_count=COALESCE(attempt_count,0)+1, error_message=NULL "
                    "WHERE id=%s AND status='queued' RETURNING id",
                    "jobs",
                    self.settings.jobs_table,
                ),
                (job.job_id,),
            )
            return cursor.fetchone() is not None

    def heartbeat(self, job: VideoJob) -> None:
        """Împinge `updated_at` cât timp jobul rulează.

        Fără asta, watchdog-ul (app/api/cron/watchdog-videos) reseta la 'queued'
        orice job 'running' cu updated_at mai vechi de STALE_RUNNING_MIN (30 min)
        și un alt worker îl relua — dublă transcodare pentru clipuri mari,
        legitime, care procesează >30 min (audit 2026-08-25). Best-effort: un
        heartbeat pierdut nu opreste procesarea.
        """
        if not self.settings.database_url:
            return
        with self.cursor() as cursor:
            cursor.execute(
                _format_table(
                    "UPDATE {jobs} SET updated_at=NOW() WHERE id=%s AND status='running'",
                    "jobs",
                    self.settings.jobs_table,
                ),
                (job.job_id,),
            )

    def mark_processing(self, job: VideoJob) -> bool:
        return self._execute_job_and_asset(
            job,
            "running",
            "UPDATE {jobs} SET status = %s, started_at = NOW(), error_message = NULL WHERE id = %s",
            "UPDATE {assets} SET status = %s, updated_at = NOW(), metadata = metadata - 'error_message' WHERE id = %s",
            ("running", job.job_id),
            ("uploading", job.asset_id),
            "UPDATE videos SET status = %s, updated_at = NOW() WHERE id = %s",
            ("processing", job.video_id) if job.video_id else None,
        )

    def update_progress(self, job: VideoJob, stage: str, pct: int) -> None:
        """Etapa + procentul afișat în wizard. Best-effort (apelantul înghite erorile)."""
        self._execute_job_only(
            "UPDATE {jobs} SET stage=%s, progress=%s, updated_at=NOW() WHERE id=%s",
            (stage, max(0, min(100, int(pct))), job.job_id),
        )

    def mark_retrying(self, job: VideoJob, attempt: int, code: str, message: str) -> None:
        del attempt  # attempt_count e gestionat de try_claim
        self._execute_job_only(
            "UPDATE {jobs} SET stage='retrying', error_code=%s, error_message=%s, "
            "updated_at=NOW() WHERE id=%s",
            (code, message, job.job_id),
        )

    def mark_ready(self, job: VideoJob, result: dict[str, Any]) -> bool:
        video_metadata = {
            "preview_url": result.get("preview_url"),
            "audio_url": result.get("audio_url"),
            "has_audio": result.get("has_audio"),
            "orientation": result.get("orientation"),
            "renditions": result.get("renditions"),
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        # Ce sunet a fost mixat efectiv (lib/video/sound-mix.ts compară cu setările curente).
        if result.get("sound_mixed_key"):
            video_metadata["sound_mixed_key"] = result.get("sound_mixed_key")
        return self._execute_job_and_asset(
            job,
            "succeeded",
            (
                "UPDATE {jobs} SET status = %s, stage = 'done', progress = 100, completed_at = NOW(), "
                "error_message = NULL, error_code = NULL, result = %s, updated_at = NOW() WHERE id = %s"
            ),
            (
                "UPDATE {assets} SET status = %s, public_url = %s, metadata = metadata || %s::jsonb, "
                "updated_at = NOW() WHERE id = %s"
            ),
            ("succeeded", _json(result), job.job_id),
            ("available", result.get("master_url"), _json(result), job.asset_id),
            (
                "UPDATE videos SET status = %s, playback_url = %s, "
                # Coperta aleasă explicit de creator nu e suprascrisă de cadrul extras.
                "thumbnail_url = CASE WHEN COALESCE(metadata->>'cover_source','') = 'custom' "
                "THEN thumbnail_url ELSE %s END, "
                "duration_ms = %s, width = %s, height = %s, "
                "metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb, updated_at = NOW() "
                "WHERE id = %s"
            ),
            (
                "ready",
                result.get("master_url"),
                result.get("thumbnail_url"),
                result.get("duration_ms"),
                result.get("width"),
                result.get("height"),
                _json(video_metadata),
                job.video_id,
            )
            if job.video_id
            else None,
        )

    def load_sound_spec(self, job: VideoJob) -> dict[str, Any] | None:
        """Sunetul de mixat: piesa clipului (doar activă + licențiată comercial) și
        setările din `metadata.sound_mix`. None = nimic de mixat (sau fără DB)."""
        if not self.settings.database_url or not job.video_id:
            return None
        with self.cursor() as cursor:
            cursor.execute(
                "SELECT v.audio_track_id, v.metadata->'sound_mix' AS sound_mix, at.audio_url "
                "FROM videos v JOIN audio_tracks at ON at.id = v.audio_track_id "
                "WHERE v.id = %s AND at.is_active = true AND at.licensed_for_commercial = true",
                (job.video_id,),
            )
            row = cursor.fetchone()
        if not row:
            return None
        return {"audio_track_id": row[0], "sound_mix": row[1], "audio_url": row[2]}

    def mark_failed(
        self, job: VideoJob, message: str, error_code: str = "internal_error", *, dead_letter: bool = False
    ) -> bool:
        """`dead_letter=True`: reîncercările tranzitorii s-au epuizat → `dead_lettered_at`."""
        error = {"error_message": message, "error_code": error_code}
        dead = ", dead_lettered_at = NOW()" if dead_letter else ""
        return self._execute_job_and_asset(
            job,
            "failed",
            (
                "UPDATE {jobs} SET status = %s, completed_at = NOW(), error_message = %s, "
                f"error_code = %s{dead}, updated_at = NOW() WHERE id = %s"
            ),
            "UPDATE {assets} SET status = %s, updated_at = NOW(), metadata = metadata || %s::jsonb WHERE id = %s",
            ("failed", message, error_code, job.job_id),
            ("failed", _json(error), job.asset_id),
            # visibility/is_hidden NU se mai ating: triggerul enforce_video_public_safety
            # privatizează clipurile publice eșuate, iar creatorul trebuie să poată reîncerca.
            (
                "UPDATE videos SET status = %s, metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb, "
                "updated_at = NOW() WHERE id = %s"
            ),
            ("failed", _json(error), job.video_id) if job.video_id else None,
        )

    def _fence(self, sql: str, params: tuple[Any, ...], *, clear_lease: bool = False):
        """Cu lease owner: gardă `locked_by` (+ eliberarea lease-ului la final)."""
        if not self.lease_owner:
            return sql, params
        if clear_lease:
            sql = sql.replace(" WHERE id", ", locked_by = NULL, lease_expires_at = NULL WHERE id", 1)
        return sql + _FENCE_SQL, (*params, self.lease_owner)

    def _execute_job_only(self, sql: str, params: tuple[Any, ...]) -> None:
        if not self.settings.database_url:
            return
        sql, params = self._fence(sql, params)
        with self.cursor() as cursor:
            cursor.execute(_format_table(sql, "jobs", self.settings.jobs_table), params)

    def _execute_job_and_asset(
        self,
        job: VideoJob,
        status: str,
        job_sql: str,
        asset_sql: str,
        job_params: tuple[Any, ...],
        asset_params: tuple[Any, ...],
        video_sql: str | None = None,
        video_params: tuple[Any, ...] | None = None,
    ) -> bool:
        """Întoarce False dacă rândul jobului e deținut de alt worker (fencing)."""
        if not self.settings.database_url:
            return True
        final = status in ("succeeded", "failed")
        job_sql, job_params = self._fence(job_sql, job_params, clear_lease=final)
        with self.cursor() as cursor:
            cursor.execute(_format_table(job_sql, "jobs", self.settings.jobs_table), job_params)
            if self.lease_owner and getattr(cursor, "rowcount", 1) == 0:
                logger.warning(
                    "Job %s is owned by another worker (lease lost); skipping %s asset/video updates",
                    job.job_id, status,
                )
                return False
            # Payload invalid (ex. reprocess admin cu `{}`): fără asset_id nu atingem video_assets.
            if job.asset_id:
                cursor.execute(_format_table(asset_sql, "assets", self.settings.assets_table), asset_params)
            if video_sql and video_params:
                cursor.execute(video_sql, video_params)
        return True


def _format_table(sql: str, placeholder: str, table_name: str) -> str:
    if not table_name.replace("_", "").isalnum():
        raise ValueError(f"Unsafe table name: {table_name}")
    return sql.replace(f"{{{placeholder}}}", table_name)


def _json(value: Any) -> str:
    import json

    return json.dumps(value)
