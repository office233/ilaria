import time

import pytest

from video_worker.errors import PermanentJobError, ShutdownRequested
from video_worker.pg_queue import ClaimedJob
from video_worker.pg_runner import PostgresJobRunner, ShutdownController

from worker_fakes import FakeProber, FakeRepository, FakeStorage, _job, _processor


class FakeQueue:
    def __init__(self, claims=(), heartbeat_ok=True):
        self.claims = list(claims)
        self.calls = []
        self.heartbeat_ok = heartbeat_ok
        self.repository = self
        self.dead_letters = []

    def reap_expired(self):
        self.calls.append("reap")
        return []

    def claim(self):
        self.calls.append("claim")
        return self.claims.pop(0) if self.claims else None

    def heartbeat(self, job_id):
        self.calls.append(("heartbeat", job_id))
        return self.heartbeat_ok

    def retry(self, job_id, delay, code, message):
        self.calls.append(("retry", job_id, delay, code, message))
        return True

    def release(self, job_id):
        self.calls.append(("release", job_id))
        return True

    def mark_failed(self, job, message, error_code="internal_error", *, dead_letter=False):
        self.dead_letters.append((job.job_id, message, error_code, dead_letter))


def _claimed(attempt=1, max_attempts=3):
    return ClaimedJob(job=_job(), attempt_count=attempt, max_attempts=max_attempts)


def _runner(tmp_path, queue, processor, **kw):
    settings = processor.settings.__class__.from_env(
        {"VIDEO_HEARTBEAT_FILE": str(tmp_path / "hb"), "VIDEO_RETRY_BACKOFF_SECONDS": "5"}
    )
    kw.setdefault("rand", lambda: 0)
    kw.setdefault("clock", lambda: 100.0)
    return PostgresJobRunner(settings, queue, processor, **kw)


def _defer_processor(tmp_path, **kw):
    return _processor(tmp_path, defer_transient=True, **kw)


def test_success_claims_processes_and_touches_heartbeat_file(tmp_path):
    queue, repository = FakeQueue([_claimed()]), FakeRepository()
    runner = _runner(tmp_path, queue, _defer_processor(tmp_path, repository=repository))

    assert runner.run(once=True) == 0
    assert queue.calls[:2] == ["reap", "claim"]
    assert repository.events[-1][0] == "ready"
    assert not any(c[0] == "retry" for c in queue.calls if isinstance(c, tuple))
    assert (tmp_path / "hb").exists()


def test_transient_failure_with_attempts_left_is_requeued_with_backoff(tmp_path):
    queue, repository, sleeps = FakeQueue([_claimed(attempt=2)]), FakeRepository(), []
    storage = FakeStorage(download_errors=[ConnectionError("r2 reset")])
    processor = _defer_processor(tmp_path, storage=storage, repository=repository, sleeps=sleeps)

    assert _runner(tmp_path, queue, processor).run(once=True) == 1
    assert ("retry", "job_1", 10.0, "storage_error", "r2 reset") in queue.calls
    assert len(storage.downloads) == 1 and sleeps == []  # fără retry inline
    assert repository.failures == [] and queue.dead_letters == []


def test_exhausted_transient_failure_is_dead_lettered(tmp_path):
    queue = FakeQueue([_claimed(attempt=3, max_attempts=3)])
    storage = FakeStorage(download_errors=[ConnectionError("down")])

    _runner(tmp_path, queue, _defer_processor(tmp_path, storage=storage)).run(once=True)

    assert queue.dead_letters == [("job_1", "down", "storage_error", True)]
    assert not any(isinstance(c, tuple) and c[0] == "retry" for c in queue.calls)


def test_permanent_failure_is_marked_failed_without_dead_letter(tmp_path):
    queue, repository = FakeQueue([_claimed()]), FakeRepository()
    prober = FakeProber(error=PermanentJobError("no_video_stream", "no video"))

    _runner(tmp_path, queue, _defer_processor(tmp_path, repository=repository, prober=prober)).run(once=True)

    assert repository.failures == [("no video", "no_video_stream")]
    assert queue.dead_letters == []
    assert not any(isinstance(c, tuple) and c[0] == "retry" for c in queue.calls)


def test_lease_heartbeat_covers_the_whole_job(tmp_path):
    queue = FakeQueue([_claimed()])

    class SlowProcessor:
        settings = _defer_processor(tmp_path).settings

        def process(self, job):
            time.sleep(0.08)
            from video_worker.worker import ProcessResult
            return ProcessResult(ok=True, message="processed")

    runner = _runner(tmp_path, queue, SlowProcessor(), heartbeat_interval=0.01)
    assert runner.run(once=True) == 0
    beats = [c for c in queue.calls if isinstance(c, tuple) and c[0] == "heartbeat"]
    assert len(beats) >= 2


def test_shutdown_during_job_releases_it_and_exits(tmp_path):
    queue = FakeQueue([_claimed(), _claimed()])
    shutdown = ShutdownController("release")

    class InterruptedProcessor:
        settings = _defer_processor(tmp_path).settings

        def process(self, job):
            shutdown.handle(15)  # semnalul sosește în timpul transcodării
            raise AssertionError("unreachable")

    runner = _runner(tmp_path, queue, InterruptedProcessor(), shutdown=shutdown)
    assert runner.run() == 0
    assert ("release", "job_1") in queue.calls
    assert queue.calls.count("claim") == 1  # bucla s-a oprit
    assert shutdown.busy is False


def test_shutdown_controller_idle_second_signal_and_finish_mode():
    idle = ShutdownController("release")
    idle.handle(15)
    assert idle.requested is True

    busy = ShutdownController("release")
    busy.busy = True
    with pytest.raises(ShutdownRequested):
        busy.handle(15)
    busy.handle(15)  # al doilea semnal (în timpul eliberării) e ignorat

    finish = ShutdownController("finish")
    finish.busy = True
    finish.handle(15)
    assert finish.requested is True
    assert issubclass(ShutdownRequested, BaseException) and not issubclass(ShutdownRequested, Exception)


def test_claim_after_shutdown_request_is_released_immediately(tmp_path):
    shutdown = ShutdownController("release")
    queue = FakeQueue([_claimed()])
    queue.claim = lambda: (shutdown.handle(15), _claimed())[1]

    runner = _runner(tmp_path, queue, _defer_processor(tmp_path), shutdown=shutdown)
    assert runner.run_once() is True
    assert ("release", "job_1") in queue.calls


def test_idle_loop_waits_poll_interval_and_reaps_at_most_every_30s(tmp_path):
    queue = FakeQueue()
    shutdown = ShutdownController()
    waits = []
    now = [100.0]

    def wait(timeout):
        waits.append(timeout)
        now[0] += 10
        if len(waits) == 4:
            shutdown.handle(15)

    runner = _runner(tmp_path, queue, _defer_processor(tmp_path), shutdown=shutdown, wait=wait, clock=lambda: now[0])
    assert runner.run() == 0
    assert waits == [2.0] * 4
    assert queue.calls.count("claim") == 4
    assert queue.calls.count("reap") == 2  # t=100 și t=130


def test_loop_survives_unexpected_errors(tmp_path):
    queue, shutdown, waits = FakeQueue(), ShutdownController(), []

    def broken_claim():
        raise RuntimeError("db down")

    queue.claim = broken_claim

    def wait(timeout):
        waits.append(timeout)
        shutdown.handle(15)

    assert _runner(tmp_path, queue, _defer_processor(tmp_path), shutdown=shutdown, wait=wait).run() == 0
    assert waits == [1.0]
