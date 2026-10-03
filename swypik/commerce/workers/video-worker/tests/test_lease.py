import threading
import time

from video_worker.lease import LeaseHeartbeat, retry_backoff


def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def test_heartbeat_beats_periodically_and_stops_on_exit():
    calls = []
    with LeaseHeartbeat(lambda: calls.append(1) or True, 0.01) as lease:
        assert _wait_for(lambda: len(calls) >= 3)
    stopped_at = len(calls)
    time.sleep(0.05)
    assert len(calls) == stopped_at
    assert lease.lost is False
    assert not any(t.name == "lease-heartbeat" for t in threading.enumerate())


def test_heartbeat_sets_lost_when_row_not_owned():
    calls = []
    with LeaseHeartbeat(lambda: calls.append(1) or False, 0.01) as lease:
        assert _wait_for(lambda: lease.lost)
        time.sleep(0.05)
    assert len(calls) == 1  # după pierdere nu mai bate


def test_heartbeat_survives_db_errors():
    outcomes = [RuntimeError("db down"), True, True]

    def beat():
        outcome = outcomes.pop(0) if outcomes else True
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    with LeaseHeartbeat(beat, 0.01) as lease:
        assert _wait_for(lambda: lease.beats >= 2)
    assert lease.lost is False


def test_retry_backoff_is_exponential_capped_with_jitter():
    assert retry_backoff(1, 5, 900, rand=lambda: 0) == 5
    assert retry_backoff(3, 5, 900, rand=lambda: 0) == 20
    assert retry_backoff(2, 5, 900, rand=lambda: 1) == 11  # 10 + 10%
    assert retry_backoff(20, 5, 900, rand=lambda: 0) == 900
    assert retry_backoff(20, 5, 900, rand=lambda: 0.5) == 945
