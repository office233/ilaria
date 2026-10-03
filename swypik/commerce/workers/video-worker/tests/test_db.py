import json

from video_worker.config import Settings
from video_worker.db import PostgresRepository
from video_worker.models import VideoJob


class FakeCursor:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self.log.append((" ".join(sql.split()), params))


class FakeConnection:
    def __init__(self):
        self.log = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.log)


def _repo(monkeypatch):
    repo = PostgresRepository(Settings.from_env({"DATABASE_URL": "postgresql://fake"}))
    connection = FakeConnection()
    monkeypatch.setattr(repo, "_connect", lambda: connection)
    monkeypatch.setattr(repo, "_release", lambda _c: None)
    return repo, connection.log


JOB = VideoJob(job_id="j1", asset_id="a1", source_key="k.mp4", output_prefix="p", video_id="v1")


def test_update_progress_and_retrying_touch_only_jobs_table(monkeypatch):
    repo, log = _repo(monkeypatch)

    repo.update_progress(JOB, "transcoding", 140)
    repo.mark_retrying(JOB, 1, "storage_error", "reset")

    assert log[0] == (
        "UPDATE video_processing_jobs SET stage=%s, progress=%s, updated_at=NOW() WHERE id=%s",
        ("transcoding", 100, "j1"),
    )
    assert "stage='retrying'" in log[1][0]
    assert log[1][1] == ("storage_error", "reset", "j1")


def test_mark_ready_writes_metadata_and_keeps_custom_cover(monkeypatch):
    repo, log = _repo(monkeypatch)
    result = {
        "master_url": "m", "thumbnail_url": "t", "preview_url": "p", "audio_url": None,
        "duration_ms": 6000, "width": 1080, "height": 1920, "has_audio": False,
        "orientation": "vertical", "renditions": [{"name": "360p", "width": 360, "height": 640, "bitrate": "800k"}],
    }

    repo.mark_ready(JOB, result)

    job_sql, _ = log[0]
    assert "stage = 'done'" in job_sql and "progress = 100" in job_sql and "error_code = NULL" in job_sql
    video_sql, video_params = log[2]
    assert "cover_source" in video_sql
    assert video_params[:6] == ("ready", "m", "t", 6000, 1080, 1920)
    metadata = json.loads(video_params[6])
    assert metadata["orientation"] == "vertical"
    assert metadata["has_audio"] is False
    assert metadata["renditions"][0]["name"] == "360p"
    assert "processed_at" in metadata
    assert video_params[7] == "v1"


def test_mark_failed_sets_error_code_and_leaves_visibility_alone(monkeypatch):
    repo, log = _repo(monkeypatch)

    repo.mark_failed(JOB, "too long", error_code="duration_too_long")

    job_sql, job_params = log[0]
    assert "error_code = %s" in job_sql
    assert job_params == ("failed", "too long", "duration_too_long", "j1")
    video_sql, video_params = log[2]
    assert "visibility" not in video_sql and "is_hidden" not in video_sql
    assert json.loads(video_params[1]) == {"error_message": "too long", "error_code": "duration_too_long"}
