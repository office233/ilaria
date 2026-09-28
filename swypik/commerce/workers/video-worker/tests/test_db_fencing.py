from video_worker.models import VideoJob

from pg_fakes import scripted_repo

JOB = VideoJob(job_id="j1", asset_id="a1", source_key="k.mp4", output_prefix="p", video_id="v1")
FENCE = "AND (locked_by IS NULL OR locked_by = %s)"


def test_lease_owner_guards_every_job_update(monkeypatch):
    repo, connection = scripted_repo(monkeypatch, lease_owner="w1")

    repo.mark_processing(JOB)
    repo.update_progress(JOB, "transcoding", 40)
    repo.mark_retrying(JOB, 1, "storage_error", "reset")
    repo.mark_ready(JOB, {"master_url": "m"})
    repo.mark_failed(JOB, "boom", error_code="internal_error")

    job_updates = [(sql, p) for sql, p in connection.log if sql.startswith("UPDATE video_processing_jobs")]
    assert len(job_updates) == 5
    for sql, params in job_updates:
        assert sql.endswith(FENCE) and params[-1] == "w1"
    ready_sql, failed_sql = job_updates[3][0], job_updates[4][0]
    assert "locked_by = NULL, lease_expires_at = NULL WHERE id" in ready_sql
    assert "locked_by = NULL, lease_expires_at = NULL WHERE id" in failed_sql
    assert "locked_by = NULL" not in job_updates[0][0]


def test_lost_lease_skips_asset_and_video_updates(monkeypatch):
    repo, connection = scripted_repo(monkeypatch, [{"rowcount": 0}], lease_owner="w1")

    assert repo.mark_ready(JOB, {"master_url": "m"}) is False
    assert len(connection.log) == 1
    assert connection.log[0][0].startswith("UPDATE video_processing_jobs")


def test_dead_letter_flag_sets_dead_lettered_at(monkeypatch):
    repo, connection = scripted_repo(monkeypatch, lease_owner="w1")

    assert repo.mark_failed(JOB, "down", error_code="storage_error", dead_letter=True) is True
    job_sql, job_params = connection.log[0]
    assert "dead_lettered_at = NOW()" in job_sql
    assert job_params == ("failed", "down", "storage_error", "j1", "w1")
    assert len(connection.log) == 3


def test_without_lease_owner_sql_is_unchanged(monkeypatch):
    repo, connection = scripted_repo(monkeypatch, [{"rowcount": 0}])

    repo.mark_failed(JOB, "boom")

    job_sql, job_params = connection.log[0]
    assert "locked_by" not in job_sql and "dead_lettered_at" not in job_sql
    assert job_params == ("failed", "boom", "internal_error", "j1")
    assert len(connection.log) == 3  # rowcount ignorat fără lease owner
