"""Dubluri de test comune pentru VideoProcessor (fără ffmpeg/S3/DB)."""
from pathlib import Path

from video_worker.config import Settings
from video_worker.models import VideoJob
from video_worker.probe import ProbeResult
from video_worker.worker import VideoProcessor

VERTICAL = ProbeResult(duration_ms=20_000, width=1080, height=1920, rotation=0, has_audio=True, video_codec="h264")


class FakeStorage:
    def __init__(self, download_errors=None):
        self.downloads = []
        self.uploads = []
        self.download_errors = list(download_errors or [])

    def download(self, bucket, key, destination):
        self.downloads.append((bucket, key, destination))
        if self.download_errors:
            raise self.download_errors.pop(0)
        Path(destination).write_bytes(b"raw video")

    def upload_directory(self, directory, bucket, prefix):
        self.uploads.append((directory, bucket, prefix))
        return {
            "master_url": f"https://cdn.example.test/{prefix}/master.m3u8",
            "thumbnail_url": f"https://cdn.example.test/{prefix}/thumbnail.jpg",
            "preview_url": f"https://cdn.example.test/{prefix}/preview.mp4",
            "audio_url": f"https://cdn.example.test/{prefix}/audio.m4a",
            "uploaded_keys": [f"{prefix}/master.m3u8", f"{prefix}/thumbnail.jpg"],
        }


class FakeProber:
    def __init__(self, result=VERTICAL, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def probe(self, source_path):
        self.calls.append(source_path)
        if self.error:
            raise self.error
        return self.result


class FakeTranscoder:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def transcode(self, source_path, output_dir, variants, *, probe, trim, thumbnail_time_ms, progress=None):
        self.calls.append(
            {"variants": variants, "probe": probe, "trim": trim, "thumbnail_time_ms": thumbnail_time_ms}
        )
        if self.error:
            raise self.error
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
        if progress:
            progress("transcoding", 50)
            progress("transcoding", 100)
        return object()


class FakeRepository:
    def __init__(self):
        self.events = []
        self.ready_results = []
        self.progress = []
        self.retries = []
        self.failures = []

    def mark_processing(self, job):
        self.events.append(("processing", job.job_id, job.asset_id))

    def update_progress(self, job, stage, pct):
        self.progress.append((stage, pct))

    def mark_retrying(self, job, attempt, code, message):
        self.retries.append((attempt, code, message))

    def mark_ready(self, job, result):
        self.ready_results.append(result)
        self.events.append(("ready", job.job_id, result["master_url"], result["thumbnail_url"]))

    def mark_failed(self, job, message, error_code="internal_error"):
        self.failures.append((message, error_code))
        self.events.append(("failed", job.job_id, message))


class FakeStatusHook:
    def __init__(self):
        self.events = []

    def handle(self, event):
        self.events.append((event.status, event.job.job_id, event.message))


class FakeAnalysisHook:
    def __init__(self):
        self.before_calls = []
        self.after_calls = []

    def before_transcode(self, job, source_path):
        self.before_calls.append((job.job_id, source_path.name))

    def after_transcode(self, job, source_path, output_dir, transcode_result, upload_result):
        self.after_calls.append((job.job_id, output_dir.name, upload_result["master_url"]))
        return {"tags": ["demo"], "moderation": {"status": "queued"}}


def _settings(tmp_path, **env):
    return Settings.from_env({"VIDEO_WORK_DIR": str(tmp_path), "S3_BUCKET": "video-bucket", **env})


def _job(**overrides):
    fields = dict(job_id="job_1", asset_id="asset_1", source_key="raw/input.mp4", output_prefix="processed/asset_1")
    fields.update(overrides)
    return VideoJob(**fields)


def _processor(tmp_path, *, storage=None, transcoder=None, repository=None, prober=None, sleeps=None, env=None, **kw):
    return VideoProcessor(
        _settings(tmp_path, **(env or {})),
        storage or FakeStorage(),
        transcoder or FakeTranscoder(),
        repository or FakeRepository(),
        prober=prober or FakeProber(),
        sleep=(sleeps.append if sleeps is not None else (lambda _s: None)),
        **kw,
    )
