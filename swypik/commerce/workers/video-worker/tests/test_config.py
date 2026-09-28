import pytest

from video_worker.config import LadderRung, Settings, parse_ladder


def test_settings_loads_local_safe_defaults(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)

    settings = Settings.from_env({})

    assert settings.redis_url is None
    assert settings.database_url is None
    assert settings.queue_name == "video:jobs"
    assert settings.s3_endpoint_url is None
    assert settings.ladder == [
        LadderRung(360, "800k"),
        LadderRung(540, "1400k"),
        LadderRung(720, "2800k"),
        LadderRung(1080, "5000k"),
    ]
    assert settings.video_encoder == "libx264"
    assert settings.min_duration_ms == 1000
    assert settings.max_duration_ms == 180000
    assert settings.max_attempts == 3
    assert settings.retry_backoff_seconds == 5


def test_settings_parses_ladder_and_table_names():
    settings = Settings.from_env(
        {
            "VIDEO_LADDER": "1080:5000k, 241:450k",
            "VIDEO_JOBS_TABLE": "jobs_table",
            "VIDEO_ASSETS_TABLE": "assets_table",
            "S3_PUBLIC_BASE_URL": "https://cdn.example.test/media/",
        }
    )

    # sortat crescator, latura scurta rotunjita in jos la par
    assert settings.ladder == [LadderRung(240, "450k"), LadderRung(1080, "5000k")]
    assert settings.jobs_table == "jobs_table"
    assert settings.assets_table == "assets_table"
    assert settings.public_base_url == "https://cdn.example.test/media"


def test_settings_loads_redis_stream_and_output_bucket_settings():
    settings = Settings.from_env(
        {
            "REDIS_URL": "redis://localhost:6379/0",
            "VIDEO_QUEUE_BACKEND": "stream",
            "VIDEO_QUEUE_NAME": "video:stream",
            "VIDEO_CONSUMER_GROUP": "video-workers",
            "VIDEO_CONSUMER_NAME": "worker-a",
            "VIDEO_OUTPUT_BUCKET": "processed-videos",
        }
    )

    assert settings.queue_backend == "stream"
    assert settings.queue_name == "video:stream"
    assert settings.consumer_group == "video-workers"
    assert settings.consumer_name == "worker-a"
    assert settings.output_bucket == "processed-videos"


def test_settings_accepts_production_s3_aliases():
    settings = Settings.from_env(
        {
            "S3_MEDIA_BUCKET": "swypik-media-prod",
            "S3_ENDPOINT": "https://account.r2.cloudflarestorage.com",
            "S3_PUBLIC_URL": "https://media.swypik.com/",
            "S3_ACCESS_KEY": "access",
            "S3_SECRET_KEY": "secret",
        }
    )

    assert settings.bucket == "swypik-media-prod"
    assert settings.s3_endpoint_url == "https://account.r2.cloudflarestorage.com"
    assert settings.public_base_url == "https://media.swypik.com"
    assert settings.aws_access_key_id == "access"
    assert settings.aws_secret_access_key == "secret"


def test_media_public_base_url_wins_over_legacy_aliases():
    settings = Settings.from_env(
        {
            "MEDIA_PUBLIC_BASE_URL": "https://media.example.test/",
            "S3_PUBLIC_URL": "https://legacy-cdn.example.test",
        }
    )

    assert settings.public_base_url == "https://media.example.test"


def test_settings_parses_encoder_limits_and_retries():
    settings = Settings.from_env(
        {
            "VIDEO_ENCODER": "h264_nvenc",
            "VIDEO_MIN_DURATION_MS": "2000",
            "VIDEO_MAX_DURATION_MS": "60000",
            "VIDEO_MAX_ATTEMPTS": "5",
            "VIDEO_RETRY_BACKOFF_SECONDS": "0.5",
        }
    )

    assert settings.video_encoder == "h264_nvenc"
    assert settings.min_duration_ms == 2000
    assert settings.max_duration_ms == 60000
    assert settings.max_attempts == 5
    assert settings.retry_backoff_seconds == 0.5


def test_settings_postgres_queue_defaults():
    settings = Settings.from_env({})

    assert settings.queue_backend == "postgres"
    assert settings.lease_seconds == 120
    assert settings.heartbeat_interval_seconds == 40
    assert settings.poll_interval_seconds == 2
    assert settings.wakeup_channel == "video:jobs:wakeup"
    assert settings.retry_backoff_max_seconds == 900
    assert str(settings.heartbeat_file).replace("\\", "/") == "/tmp/video-worker-heartbeat"
    assert settings.shutdown_mode == "release"
    assert settings.worker_id.count(":") >= 2


def test_settings_postgres_queue_overrides():
    settings = Settings.from_env(
        {
            "VIDEO_WORKER_ID": "host-a:1",
            "VIDEO_LEASE_SECONDS": "12",
            "VIDEO_POLL_INTERVAL_SECONDS": "0.5",
            "VIDEO_RETRY_BACKOFF_MAX_SECONDS": "60",
            "VIDEO_SHUTDOWN_MODE": "finish",
            "VIDEO_QUEUE_BACKEND": "LIST",
        }
    )

    assert settings.worker_id == "host-a:1"
    assert settings.lease_seconds == 12
    assert settings.heartbeat_interval_seconds == 5  # minim 5 s
    assert settings.poll_interval_seconds == 0.5
    assert settings.retry_backoff_max_seconds == 60
    assert settings.shutdown_mode == "finish"
    assert settings.queue_backend == "list"


@pytest.mark.parametrize("key,value", [("VIDEO_QUEUE_BACKEND", "kafka"), ("VIDEO_SHUTDOWN_MODE", "later")])
def test_settings_rejects_unknown_queue_options(key, value):
    with pytest.raises(ValueError, match=key):
        Settings.from_env({key: value})


def test_settings_rejects_unknown_encoder():
    with pytest.raises(ValueError, match="VIDEO_ENCODER"):
        Settings.from_env({"VIDEO_ENCODER": "hevc_qsv"})


@pytest.mark.parametrize("value", ["abc", "360", "x:800k", "0:800k"])
def test_parse_ladder_rejects_malformed_entries(value):
    with pytest.raises(ValueError):
        parse_ladder(value)
