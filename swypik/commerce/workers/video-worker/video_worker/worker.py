from __future__ import annotations

import contextlib
import logging
import mimetypes
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .config import Settings
from .errors import PermanentJobError, classify_error
from .extensions import StatusEvent
from .io_helpers import download_http as _download_http
from .io_helpers import heartbeat as _heartbeat
from .models import VideoJob
from .probe import ClipWindow, FfprobeProber, ProbeResult, clip_window
from .renditions import compute_renditions, orientation
from .sound_mix import SoundSpec, sound_key, spec_from_row

logger = logging.getLogger(__name__)

#: De câte ori se reface mixul dacă creatorul schimbă sunetul în timpul procesării.
MAX_SOUND_PASSES = 3

#: Toleranță peste limita maximă (containerele raportează durate ușor rotunjite).
MAX_DURATION_TOLERANCE_MS = 500

# Harta progresului (0..100) pe etape; transcodarea ocupă intervalul 15..85.
_TRANSCODE_START, _TRANSCODE_END = 15, 85


@dataclass(frozen=True)
class ProcessResult:
    ok: bool
    message: str
    details: Mapping[str, Any] | None = None


class VideoProcessor:
    def __init__(
        self,
        settings: Settings,
        storage,
        transcoder,
        repository,
        status_hooks: Iterable[object] | None = None,
        analysis_hooks: Iterable[object] | None = None,
        prober=None,
        sleep: Callable[[float], None] | None = None,
        defer_transient: bool = False,
        sound_mixer=None,
    ) -> None:
        self.settings = settings
        self.storage = storage
        self.transcoder = transcoder
        self.repository = repository
        self.status_hooks = list(status_hooks or [])
        self.analysis_hooks = list(analysis_hooks or [])
        self.prober = prober or FfprobeProber()
        self._sleep = sleep or time.sleep
        # Coada Postgres: jobul e deja revendicat (lease), o singură încercare;
        # eroarea tranzitorie e întoarsă cozii (retry cu backoff / dead letter),
        # iar heartbeat-ul lease-ului acoperă tot jobul (îl ține pg_runner).
        self.defer_transient = defer_transient
        # „Adaugă sunet”: fără mixer (teste, --job-json fără DB) clipul păstrează audio-ul sursei.
        self.sound_mixer = sound_mixer

    def process(self, job: VideoJob) -> ProcessResult:
        if not self.defer_transient and not self._try_claim(job):
            logger.info("Job %s skipped (not in 'queued' state)", job.job_id)
            return ProcessResult(ok=True, message="JOB_SKIPPED")

        max_attempts = 1 if self.defer_transient else max(1, int(self.settings.max_attempts))
        processing_marked = False
        for attempt in range(1, max_attempts + 1):
            try:
                if not processing_marked:
                    self.repository.mark_processing(job)
                    self._emit_status(StatusEvent(job=job, status="processing"))
                    processing_marked = True
                details = self._run_attempt(job)
                return ProcessResult(ok=True, message="processed", details=details)
            except Exception as exc:
                code, transient = classify_error(exc)
                message = str(exc) or exc.__class__.__name__
                if transient and attempt < max_attempts:
                    delay = self.settings.retry_backoff_seconds * 2 ** (attempt - 1)
                    logger.warning(
                        "Video job %s attempt %d/%d failed (%s): %s; retrying in %.1fs",
                        job.job_id, attempt, max_attempts, code, message, delay,
                    )
                    self._mark_retrying(job, attempt, code, message)
                    self._sleep(delay)
                    continue
                if transient and self.defer_transient:
                    logger.warning("Video job %s failed transiently (%s): %s", job.job_id, code, message)
                    return ProcessResult(
                        ok=False, message=message,
                        details={"error_code": code, "transient": True, "attempts": attempt},
                    )
                logger.exception("Video job %s failed (%s): %s", job.job_id, code, message)
                self._mark_failed(job, message, code)
                return ProcessResult(
                    ok=False, message=message, details={"error_code": code, "attempts": attempt}
                )
        raise AssertionError("unreachable")  # pragma: no cover

    def _try_claim(self, job: VideoJob) -> bool:
        """ATOMIC CLAIM (stream/list): refuză duplicatele. Dacă UPDATE-ul nu
        mută rândul din 'queued', jobul e deja luat / terminat — ack & skip."""
        try_claim = getattr(self.repository, "try_claim", None)
        if try_claim is None:
            return True
        try:
            return bool(try_claim(job))
        except Exception:
            # Fără claim nu știm dacă alt worker a luat deja jobul: NU procesăm (dublă
            # transcodare). Rândul rămâne 'queued'; watchdog-ul îl republică.
            logger.exception("try_claim raised for job %s; skipping (job stays queued)", job.job_id)
            return False

    def _run_attempt(self, job: VideoJob) -> dict[str, Any]:
        source_bucket = job.source_bucket or job.bucket or self.settings.bucket
        output_bucket = job.output_bucket or job.bucket or self.settings.output_bucket or self.settings.bucket
        self._progress(job, "downloading", 5)
        with tempfile.TemporaryDirectory(prefix=f"{job.job_id}-", dir=self._work_dir()) as temp_dir:
            temp_path = Path(temp_dir)
            source_path = temp_path / "source" / Path(job.source_key).name
            output_dir = temp_path / "hls"
            source_path.parent.mkdir(parents=True, exist_ok=True)
            self._download_source(job, source_bucket, source_path)

            self._progress(job, "probing", 12)
            probe: ProbeResult = self.prober.probe(source_path)
            window = clip_window(probe, job.trim)
            self._validate_duration(job, window)
            variants = compute_renditions(probe.width, probe.height, self.settings.ladder)

            self._before_transcode(job, source_path)
            self._progress(job, "transcoding", _TRANSCODE_START)
            span = _TRANSCODE_END - _TRANSCODE_START

            def on_progress(_stage: str, pct: int) -> None:
                clamped = max(0, min(100, int(pct)))
                self._progress(job, "transcoding", _TRANSCODE_START + clamped * span // 100)

            # Heartbeat pe toată durata pașilor lungi (transcode + upload),
            # ca watchdog-ul să nu fure jobul de sub un worker sănătos. În modul
            # Postgres lease-ul e prelungit de pg_runner pe TOT jobul.
            inner_heartbeat = contextlib.nullcontext() if self.defer_transient else _heartbeat(self.repository, job)
            with inner_heartbeat:
                transcode_result, mixed = self._transcode_with_sound(
                    job, source_path, output_dir, temp_path, variants, probe, window, on_progress
                )
                self._progress(job, "uploading", 90)
                upload_result = self.storage.upload_directory(output_dir, output_bucket, job.output_prefix)

            result: dict[str, Any] = {
                **upload_result,
                "audio_url": upload_result.get("audio_url"),
                "duration_ms": window.duration_ms,
                "width": probe.width,
                "height": probe.height,
                "has_audio": probe.has_audio or mixed is not None,
                "sound_mixed_key": sound_key(mixed),
                "orientation": orientation(probe.width, probe.height),
                "renditions": [
                    {"name": v.name, "width": v.width, "height": v.height, "bitrate": v.bitrate}
                    for v in variants
                ],
                "source": {
                    "duration_ms": probe.duration_ms,
                    "rotation": probe.rotation,
                    "video_codec": probe.video_codec,
                    "trim_start_ms": window.start_ms,
                },
            }
            analysis = self._after_transcode(job, source_path, output_dir, transcode_result, result)
            if analysis:
                result["analysis"] = analysis
            self.repository.mark_ready(job, result)
            self._emit_status(StatusEvent(job=job, status="ready", result=result))
            return result

    def _resolve_sound(self, job: VideoJob) -> SoundSpec | None:
        if self.sound_mixer is None:
            return None
        load = getattr(self.repository, "load_sound_spec", None)
        if load is None:
            return None
        try:
            return spec_from_row(load(job))
        except Exception:
            logger.exception("Job %s: could not read the sound settings (keeping original audio)", job.job_id)
            return None

    def _transcode_with_sound(self, job, source_path, output_dir, temp_path, variants, probe, window, on_progress):
        """Transcodează (cu mixul de sunet, dacă există). Dacă setările de sunet s-au
        schimbat în timpul transcodării, reface mixul, altfel clipul ar ieși cu
        sunetul vechi până la următoarea editare. Un mix eșuat nu pică jobul: clipul
        se publică cu audio-ul original, iar `sound_mixed_key='none'` o arată."""
        spec = self._resolve_sound(job)
        result = None
        mixed: SoundSpec | None = None
        for attempt in range(1, MAX_SOUND_PASSES + 1):
            mixed_audio: Path | None = None
            mixed = None
            if spec is not None:
                try:
                    mixed_audio = self.sound_mixer.prepare(
                        spec, source_path, window,
                        source_has_audio=probe.has_audio, work_dir=temp_path / f"sound-{attempt}",
                    )
                    mixed = spec
                except Exception:
                    logger.exception(
                        "Job %s: sound mix failed (track %s); keeping original audio", job.job_id, spec.track_id
                    )
            if attempt > 1 and output_dir.exists():
                shutil.rmtree(output_dir)
            kwargs: dict[str, Any] = {}
            if mixed_audio is not None and mixed is not None:
                kwargs = {"audio_override": mixed_audio, "speech_audio": mixed.keep_original}
            result = self.transcoder.transcode(
                source_path,
                output_dir,
                variants,
                probe=probe,
                trim=job.trim,
                thumbnail_time_ms=job.thumbnail_time_ms,
                progress=on_progress,
                **kwargs,
            )
            latest = self._resolve_sound(job)
            if sound_key(latest) == sound_key(spec):
                break
            logger.info("Job %s: sound changed during processing; remixing", job.job_id)
            spec = latest
        return result, mixed

    def _download_source(self, job: VideoJob, source_bucket: str, source_path: Path) -> None:
        # Upload-urile creatorilor vin fără source_url → citim direct din storage.
        # source_url extern (re-encode din admin): HTTP + oglindire brută în R2.
        if not job.source_url:
            self.storage.download(source_bucket, job.source_key, source_path)
            return
        logger.info("Job %s: pulling external source %s", job.job_id, job.source_url)
        _download_http(job.source_url, source_path)
        try:
            self._upload_raw_to_storage(source_path, source_bucket, job.source_key)
        except Exception:
            logger.exception("Job %s: raw mirror upload failed (continuing)", job.job_id)

    def _validate_duration(self, job: VideoJob, window: ClipWindow) -> None:
        limits = job.limits
        min_ms = self.settings.min_duration_ms
        max_ms = self.settings.max_duration_ms
        if limits is not None and limits.min_duration_ms is not None:
            min_ms = limits.min_duration_ms
        if limits is not None and limits.max_duration_ms is not None:
            max_ms = limits.max_duration_ms
        if window.duration_ms < min_ms:
            raise PermanentJobError(
                "duration_too_short", f"clip is {window.duration_ms} ms; minimum is {min_ms} ms"
            )
        if window.duration_ms > max_ms + MAX_DURATION_TOLERANCE_MS:
            raise PermanentJobError(
                "duration_too_long", f"clip is {window.duration_ms} ms; maximum is {max_ms} ms"
            )

    def _progress(self, job: VideoJob, stage: str, pct: int) -> None:
        """Best-effort: progresul nu are voie să pice jobul."""
        update = getattr(self.repository, "update_progress", None)
        if update is None:
            return
        try:
            update(job, stage, pct)
        except Exception:
            logger.warning("update_progress failed for job %s (%s %d%%)", job.job_id, stage, pct)

    def _mark_retrying(self, job: VideoJob, attempt: int, code: str, message: str) -> None:
        mark = getattr(self.repository, "mark_retrying", None)
        if mark is None:
            return
        try:
            mark(job, attempt, code, message)
        except Exception:
            logger.warning("mark_retrying failed for job %s", job.job_id)

    def _mark_failed(self, job: VideoJob, message: str, code: str) -> None:
        try:
            self.repository.mark_failed(job, message, error_code=code)
            self._emit_status(StatusEvent(job=job, status="failed", message=message))
        except Exception:
            logger.exception("Could not mark video job %s as failed", job.job_id)

    def _upload_raw_to_storage(self, source_path: Path, bucket: str, key: str) -> None:
        """Mirror the freshly-downloaded source into R2/S3 under `key`.
        Uses the storage backend's underlying boto3 client when available.
        No-op if the storage backend lacks a client.
        """
        client = getattr(self.storage, "client", None)
        if client is None:
            return
        content_type, _ = mimetypes.guess_type(Path(key).name)
        client.upload_file(
            str(source_path),
            bucket,
            key,
            ExtraArgs={"ContentType": content_type or "application/octet-stream"},
        )

    def _work_dir(self) -> str:
        self.settings.work_dir.mkdir(parents=True, exist_ok=True)
        return str(self.settings.work_dir)

    def _emit_status(self, event: StatusEvent) -> None:
        for hook in self.status_hooks:
            handle = getattr(hook, "handle", None)
            if handle is None:
                continue
            try:
                handle(event)
            except Exception:
                logger.exception(
                    "Status hook %s failed for video job %s",
                    hook.__class__.__name__,
                    event.job.job_id,
                )

    def _before_transcode(self, job: VideoJob, source_path: Path) -> None:
        for hook in self.analysis_hooks:
            before = getattr(hook, "before_transcode", None)
            if before is not None:
                before(job, source_path)

    def _after_transcode(
        self,
        job: VideoJob,
        source_path: Path,
        output_dir: Path,
        transcode_result: object,
        upload_result: Mapping[str, Any],
    ) -> dict[str, Any]:
        analysis: dict[str, Any] = {}
        for hook in self.analysis_hooks:
            after = getattr(hook, "after_transcode", None)
            if after is None:
                continue
            hook_result = after(job, source_path, output_dir, transcode_result, upload_result)
            if hook_result:
                analysis.update(dict(hook_result))
        return analysis
