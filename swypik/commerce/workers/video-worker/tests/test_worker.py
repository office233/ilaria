from pathlib import Path

from video_worker.models import Trim

from worker_fakes import (
    FakeAnalysisHook,
    FakeRepository,
    FakeStatusHook,
    FakeStorage,
    FakeTranscoder,
    _job,
    _processor,
)


def test_processor_downloads_probes_transcodes_uploads_and_marks_ready(tmp_path):
    storage, transcoder, repository = FakeStorage(), FakeTranscoder(), FakeRepository()

    result = _processor(tmp_path, storage=storage, transcoder=transcoder, repository=repository).process(_job())

    assert result.ok is True
    assert storage.downloads[0][0:2] == ("video-bucket", "raw/input.mp4")
    assert [(v.width, v.height) for v in transcoder.calls[0]["variants"]] == [
        (360, 640), (540, 960), (720, 1280), (1080, 1920),
    ]
    assert storage.uploads[0][1:] == ("video-bucket", "processed/asset_1")
    assert repository.events == [
        ("processing", "job_1", "asset_1"),
        (
            "ready",
            "job_1",
            "https://cdn.example.test/processed/asset_1/master.m3u8",
            "https://cdn.example.test/processed/asset_1/thumbnail.jpg",
        ),
    ]
    ready = repository.ready_results[0]
    assert ready["duration_ms"] == 20_000
    assert (ready["width"], ready["height"]) == (1080, 1920)
    assert ready["has_audio"] is True
    assert ready["orientation"] == "vertical"
    assert ready["preview_url"].endswith("/preview.mp4")
    assert ready["audio_url"].endswith("/audio.m4a")
    assert ready["renditions"][0] == {"name": "360p", "width": 360, "height": 640, "bitrate": "800k"}
    assert len(ready["renditions"]) == 4


def test_progress_stages_are_reported_in_order(tmp_path):
    repository = FakeRepository()

    _processor(tmp_path, repository=repository).process(_job())

    stages = [stage for stage, _ in repository.progress]
    assert stages == ["downloading", "probing", "transcoding", "transcoding", "transcoding", "uploading"]
    assert [pct for _, pct in repository.progress] == [5, 12, 15, 50, 85, 90]


def test_progress_failures_never_fail_the_job(tmp_path):
    class BrokenProgressRepo(FakeRepository):
        def update_progress(self, job, stage, pct):
            raise RuntimeError("db hiccup")

    repository = BrokenProgressRepo()
    assert _processor(tmp_path, repository=repository).process(_job()).ok is True
    assert repository.ready_results


def test_trim_and_thumbnail_time_are_forwarded_and_duration_is_effective(tmp_path):
    transcoder, repository = FakeTranscoder(), FakeRepository()
    job = _job(trim=Trim(start_ms=2000, end_ms=8000), thumbnail_time_ms=1500)

    _processor(tmp_path, transcoder=transcoder, repository=repository).process(job)

    assert transcoder.calls[0]["trim"] == Trim(start_ms=2000, end_ms=8000)
    assert transcoder.calls[0]["thumbnail_time_ms"] == 1500
    assert repository.ready_results[0]["duration_ms"] == 6000


def test_local_job_downloads_from_storage_not_http(tmp_path, monkeypatch):
    def forbid_http(*_args, **_kwargs):
        raise AssertionError("HTTP download must not be used for creator uploads")

    monkeypatch.setattr("video_worker.worker._download_http", forbid_http)
    storage = FakeStorage()

    result = _processor(tmp_path, storage=storage).process(_job(source_url=None))

    assert result.ok is True
    assert storage.downloads[0][1] == "raw/input.mp4"


def test_external_source_url_mirrors_raw_with_guessed_content_type(tmp_path, monkeypatch):
    uploaded = []

    class Client:
        def upload_file(self, filename, bucket, key, ExtraArgs):
            uploaded.append((bucket, key, ExtraArgs["ContentType"]))

    class StorageWithClient(FakeStorage):
        client = Client()

    monkeypatch.setattr(
        "video_worker.worker._download_http", lambda url, dest: Path(dest).write_bytes(b"x" * 2048)
    )
    storage = StorageWithClient()

    result = _processor(tmp_path, storage=storage).process(
        _job(source_url="https://example.test/clip.mov", source_key="videos/raw/v1.mov")
    )

    assert result.ok is True
    assert storage.downloads == []
    assert uploaded == [("video-bucket", "videos/raw/v1.mov", "video/quicktime")]


def test_processor_uses_separate_source_and_output_buckets(tmp_path):
    storage = FakeStorage()

    result = _processor(tmp_path, storage=storage, env={"VIDEO_OUTPUT_BUCKET": "default-output"}).process(
        _job(source_bucket="raw-videos", output_bucket="processed-videos")
    )

    assert result.ok is True
    assert storage.downloads[0][0:2] == ("raw-videos", "raw/input.mp4")
    assert storage.uploads[0][1:] == ("processed-videos", "processed/asset_1")


def test_processor_emits_status_and_analysis_extension_hooks(tmp_path):
    status_hook, analysis_hook, repository = FakeStatusHook(), FakeAnalysisHook(), FakeRepository()

    result = _processor(
        tmp_path, repository=repository, status_hooks=[status_hook], analysis_hooks=[analysis_hook]
    ).process(_job(job_id="job_4", output_prefix="processed/asset_4"))

    assert result.ok is True
    assert status_hook.events == [("processing", "job_4", None), ("ready", "job_4", None)]
    assert analysis_hook.before_calls == [("job_4", "input.mp4")]
    assert analysis_hook.after_calls == [
        ("job_4", "hls", "https://cdn.example.test/processed/asset_4/master.m3u8")
    ]
    assert repository.ready_results[0]["analysis"] == {"tags": ["demo"], "moderation": {"status": "queued"}}
