import json

import pytest

from video_worker.models import InvalidJobPayload
from video_worker.pg_queue import STATS_KEYS, PostgresQueue, build_job

from pg_fakes import scripted_repo

PAYLOAD = {
    "job_id": "stale-id-from-producer",
    "asset_id": "a1",
    "source_key": "videos/raw/v1/clip.mov",
    "output_prefix": "videos/hls/v1",
}


def _queue(monkeypatch, results=None, **env):
    repo, connection = scripted_repo(monkeypatch, results, lease_owner="w1", **env)
    return PostgresQueue(repo.settings, repo), connection.log


def test_claim_uses_skip_locked_and_builds_job_from_row(monkeypatch):
    row = ("job-uuid", "v1", "a1", dict(PAYLOAD), 2, 3, None)
    queue, log = _queue(monkeypatch, [{"rows": [row]}], VIDEO_LEASE_SECONDS="90")

    claimed = queue.claim()

    sql, params = log[0]
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "ORDER BY priority DESC, scheduled_at" in sql
    assert "UPDATE video_processing_jobs j" in sql and "attempt_count = j.attempt_count + 1" in sql
    assert params == ("w1", 90)
    assert claimed.job.job_id == "job-uuid"  # id-ul rândului câștigă
    assert claimed.job.video_id == "v1"  # completat din rând
    assert claimed.job.source_key == "videos/raw/v1/clip.mov"
    assert (claimed.attempt_count, claimed.max_attempts, claimed.attempts_left) == (2, 3, True)


def test_claim_returns_none_when_nothing_is_due(monkeypatch):
    queue, log = _queue(monkeypatch, [{"rows": []}])
    assert queue.claim() is None
    assert len(log) == 1


def test_claim_marks_invalid_payload_failed_and_moves_on(monkeypatch):
    bad = ("bad-uuid", "v9", None, {}, 1, 3, None)
    good = ("good-uuid", None, "a1", json.dumps(PAYLOAD), 1, 3, None)
    queue, log = _queue(monkeypatch, [{"rows": [bad]}, {"rowcount": 1}, {}, {"rows": [good]}])

    claimed = queue.claim()

    assert claimed.job.job_id == "good-uuid"
    fail_sql, fail_params = log[1]
    assert fail_sql.startswith("UPDATE video_processing_jobs SET status = %s")
    assert fail_params[0] == "failed" and fail_params[2] == "invalid_payload" and fail_params[3] == "bad-uuid"
    assert "dead_lettered_at" not in fail_sql
    # fără asset_id → video_assets neatins; videos marcat failed
    assert not any("video_assets" in sql for sql, _ in log)
    assert any(sql.startswith("UPDATE videos SET status") and p[-1] == "v9" for sql, p in log)


def test_claim_never_crashes_on_non_json_payload(monkeypatch):
    bad = ("bad-uuid", None, "a1", "not json", 1, 3, None)
    queue, log = _queue(monkeypatch, [{"rows": [bad]}, {"rowcount": 1}, {}, {"rows": []}])
    assert queue.claim() is None
    assert log[1][1][2] == "invalid_payload"


def test_build_job_fills_row_fields_but_keeps_payload_values():
    job = build_job("row-id", "v-row", "a-row", {**PAYLOAD, "videoId": "v-payload"}, "https://x.test/a.mp4")
    assert job.job_id == "row-id"
    assert job.video_id == "v-payload"
    assert job.asset_id == "a1"
    assert job.source_url == "https://x.test/a.mp4"
    with pytest.raises(InvalidJobPayload):
        build_job("row-id", None, None, [], None)


def test_reap_dead_letters_expired_leases_without_attempts(monkeypatch):
    queue, log = _queue(monkeypatch, [{"rows": [("j1",), ("j2",)]}])

    assert queue.reap_expired() == ["j1", "j2"]
    sql, params = log[0]
    assert "dead_lettered_at=NOW()" in sql and "'lease_expired'" in sql
    assert "lease_expires_at < NOW() AND attempt_count >= max_attempts" in sql
    assert params == ()


def test_heartbeat_extends_lease_only_for_owner(monkeypatch):
    queue, log = _queue(monkeypatch, [{"rows": [("j1",)]}, {"rows": []}])

    assert queue.heartbeat("j1") is True
    assert queue.heartbeat("j1") is False
    sql, params = log[0]
    assert "lease_expires_at = NOW() + make_interval(secs => %s)" in sql
    assert "locked_by=%s AND status='running'" in sql
    assert params == (120, "j1", "w1")


def test_retry_and_release_are_guarded_by_owner(monkeypatch):
    queue, log = _queue(monkeypatch, [{"rowcount": 1}, {"rowcount": 0}])

    assert queue.retry("j1", 12.5, "storage_error", "reset") is True
    assert queue.release("j1") is False
    retry_sql, retry_params = log[0]
    assert "status='queued', scheduled_at = NOW() + make_interval(secs => %s)" in retry_sql
    assert retry_params == (12.5, "storage_error", "reset", "j1", "w1")
    release_sql, release_params = log[1]
    assert "attempt_count = GREATEST(attempt_count - 1, 0)" in release_sql
    assert release_params == ("j1", "w1")


def test_stats_maps_single_row(monkeypatch):
    queue, log = _queue(monkeypatch, [{"rows": [(4, 1, 2, 0, 3, 5, 40, 17)]}])

    stats = queue.stats()

    assert list(stats) == list(STATS_KEYS)
    assert stats["queued"] == 4 and stats["dead_letter"] == 3 and stats["oldest_queued_age_s"] == 17
    assert len(log) == 1 and "FILTER" in log[0][0]
