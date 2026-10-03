import pytest

from video_worker.errors import PermanentJobError
from video_worker.models import DurationLimits, Trim
from video_worker.probe import ProbeResult

from worker_fakes import (
    FakeProber,
    FakeRepository,
    FakeStorage,
    FakeTranscoder,
    _job,
    _processor,
)


def test_transient_failure_is_retried_then_succeeds(tmp_path):
    storage = FakeStorage(download_errors=[ConnectionError("r2 reset"), ConnectionError("r2 reset")])
    repository = FakeRepository()
    sleeps = []

    result = _processor(
        tmp_path, storage=storage, repository=repository, sleeps=sleeps,
        env={"VIDEO_RETRY_BACKOFF_SECONDS": "5"},
    ).process(_job())

    assert result.ok is True
    assert len(storage.downloads) == 3
    assert sleeps == [5, 10]  # backoff exponențial
    assert [(a, c) for a, c, _ in repository.retries] == [(1, "storage_error"), (2, "storage_error")]
    assert repository.events[0] == ("processing", "job_1", "asset_1")  # marcat o singură dată
    assert repository.events[-1][0] == "ready"


def test_transient_failure_exhausts_attempts(tmp_path):
    storage = FakeStorage(download_errors=[ConnectionError("down")] * 5)
    repository = FakeRepository()
    sleeps = []

    result = _processor(tmp_path, storage=storage, repository=repository, sleeps=sleeps).process(_job())

    assert result.ok is False
    assert len(storage.downloads) == 3
    assert len(sleeps) == 2
    assert repository.failures == [("down", "storage_error")]


def test_defer_transient_runs_one_attempt_and_leaves_retry_to_the_queue(tmp_path):
    storage = FakeStorage(download_errors=[ConnectionError("r2 reset")])
    sleeps = []

    class ClaimingRepository(FakeRepository):
        def try_claim(self, job):
            raise AssertionError("postgres mode must not call try_claim")

    repository = ClaimingRepository()
    result = _processor(
        tmp_path, storage=storage, repository=repository, sleeps=sleeps, defer_transient=True
    ).process(_job())

    assert result.ok is False
    assert result.details == {"error_code": "storage_error", "transient": True, "attempts": 1}
    assert len(storage.downloads) == 1 and sleeps == []
    assert repository.failures == [] and repository.retries == []


def test_defer_transient_still_fails_permanent_errors(tmp_path):
    repository = FakeRepository()
    prober = FakeProber(error=PermanentJobError("no_video_stream", "no video"))

    result = _processor(tmp_path, repository=repository, prober=prober, defer_transient=True).process(_job())

    assert result.ok is False and not result.details.get("transient")
    assert repository.failures == [("no video", "no_video_stream")]


def test_permanent_error_is_not_retried(tmp_path):
    repository = FakeRepository()
    sleeps = []
    prober = FakeProber(error=PermanentJobError("no_video_stream", "source has no video stream"))

    result = _processor(tmp_path, repository=repository, prober=prober, sleeps=sleeps).process(_job())

    assert result.ok is False
    assert len(prober.calls) == 1
    assert sleeps == []
    assert repository.retries == []
    assert repository.failures == [("source has no video stream", "no_video_stream")]
    assert result.details["error_code"] == "no_video_stream"


def test_ffmpeg_failure_is_transcode_failed_without_retry(tmp_path):
    repository = FakeRepository()
    transcoder = FakeTranscoder(error=RuntimeError("ffmpeg command failed: boom"))

    result = _processor(tmp_path, repository=repository, transcoder=transcoder).process(_job())

    assert result.ok is False
    assert len(transcoder.calls) == 1
    assert repository.failures == [("ffmpeg command failed: boom", "transcode_failed")]


@pytest.mark.parametrize(
    "duration_ms,limits,expected",
    [
        (200_000, None, "duration_too_long"),
        (500, None, "duration_too_short"),
        (40_000, DurationLimits(max_duration_ms=30_000), "duration_too_long"),
        (4_000, DurationLimits(min_duration_ms=5_000), "duration_too_short"),
    ],
)
def test_duration_limits_fail_permanently(tmp_path, duration_ms, limits, expected):
    repository, transcoder = FakeRepository(), FakeTranscoder()
    prober = FakeProber(result=ProbeResult(duration_ms, 1080, 1920, 0, True, "h264"))

    result = _processor(tmp_path, repository=repository, transcoder=transcoder, prober=prober).process(
        _job(limits=limits)
    )

    assert result.ok is False
    assert repository.failures[0][1] == expected
    assert transcoder.calls == []


def test_max_duration_has_500ms_tolerance(tmp_path):
    prober = FakeProber(result=ProbeResult(180_400, 1080, 1920, 0, True, "h264"))
    assert _processor(tmp_path, prober=prober).process(_job()).ok is True


def test_trim_brings_long_source_within_limits(tmp_path):
    prober = FakeProber(result=ProbeResult(600_000, 1080, 1920, 0, True, "h264"))
    job = _job(trim=Trim(start_ms=10_000, end_ms=70_000))
    assert _processor(tmp_path, prober=prober).process(job).ok is True
