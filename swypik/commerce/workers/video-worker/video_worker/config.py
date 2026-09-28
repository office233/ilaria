from __future__ import annotations

import os
import socket
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class Variant:
    name: str
    width: int
    height: int
    bitrate: str


@dataclass(frozen=True)
class LadderRung:
    """O treaptă din scara de calitate: latura SCURTĂ țintă + bitrate."""

    short: int
    bitrate: str


DEFAULT_LADDER = "360:800k,540:1400k,720:2800k,1080:5000k"
SUPPORTED_ENCODERS = ("libx264", "h264_nvenc")


def default_ladder() -> list[LadderRung]:
    return parse_ladder(DEFAULT_LADDER)


@dataclass(frozen=True)
class Settings:
    redis_url: str | None
    database_url: str | None
    queue_name: str
    bucket: str
    s3_endpoint_url: str | None
    s3_region: str
    public_base_url: str | None
    jobs_table: str
    assets_table: str
    poll_timeout_seconds: int
    work_dir: Path
    ladder: list[LadderRung] = field(default_factory=default_ladder)
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    queue_backend: str = "postgres"
    consumer_group: str = "video-workers"
    consumer_name: str = "video-worker"
    output_bucket: str | None = None
    failed_stream: str | None = None
    stale_pending_ms: int = 10 * 60 * 1000
    ack_failed_jobs: bool = True
    video_encoder: str = "libx264"
    min_duration_ms: int = 1000
    max_duration_ms: int = 180_000
    max_attempts: int = 3
    retry_backoff_seconds: float = 5.0
    # Coada Postgres (competing consumers, vezi pg_queue.py).
    worker_id: str = field(default_factory=lambda: default_worker_id())
    lease_seconds: int = 120
    poll_interval_seconds: float = 2.0
    wakeup_channel: str = "video:jobs:wakeup"
    retry_backoff_max_seconds: float = 900.0
    heartbeat_file: Path = Path("/tmp/video-worker-heartbeat")
    shutdown_mode: str = "release"

    @property
    def heartbeat_interval_seconds(self) -> float:
        """Lease-ul se prelungește de ~3 ori pe durata lui (minim la 5 s)."""
        return max(5.0, self.lease_seconds / 3)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        values = dict(os.environ if env is None else env)
        public_base_url = _optional(values, "MEDIA_PUBLIC_BASE_URL", "S3_PUBLIC_BASE_URL", "S3_PUBLIC_URL", "R2_PUBLIC_BASE_URL", "R2_PUBLIC_URL")
        if public_base_url:
            public_base_url = public_base_url.rstrip("/")

        return cls(
            redis_url=_optional(values, "REDIS_URL", "VIDEO_REDIS_URL"),
            database_url=_optional(values, "DATABASE_URL", "POSTGRES_URL"),
            queue_backend=parse_queue_backend(values.get("VIDEO_QUEUE_BACKEND")),
            queue_name=values.get("VIDEO_QUEUE_NAME", values.get("VIDEO_QUEUE", "video:jobs")),
            consumer_group=values.get("VIDEO_CONSUMER_GROUP", "video-workers"),
            consumer_name=values.get("VIDEO_CONSUMER_NAME", socket.gethostname() or "video-worker"),
            bucket=values.get("S3_MEDIA_BUCKET", values.get("S3_BUCKET", values.get("R2_BUCKET", "video"))),
            output_bucket=_optional(values, "VIDEO_OUTPUT_BUCKET", "S3_OUTPUT_BUCKET", "R2_OUTPUT_BUCKET"),
            s3_endpoint_url=_optional(values, "S3_ENDPOINT_URL", "S3_ENDPOINT", "R2_ENDPOINT_URL", "R2_ENDPOINT"),
            s3_region=values.get("AWS_REGION", values.get("S3_REGION", values.get("R2_REGION", "auto"))),
            public_base_url=public_base_url,
            jobs_table=values.get("VIDEO_JOBS_TABLE", "video_processing_jobs"),
            assets_table=values.get("VIDEO_ASSETS_TABLE", "video_assets"),
            ladder=parse_ladder(values.get("VIDEO_LADDER")),
            poll_timeout_seconds=int(values.get("VIDEO_POLL_TIMEOUT_SECONDS", "5")),
            work_dir=Path(values.get("VIDEO_WORK_DIR", tempfile.gettempdir())) / "Swypik-video-worker",
            aws_access_key_id=_optional(values, "AWS_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID", "S3_ACCESS_KEY", "R2_ACCESS_KEY_ID"),
            aws_secret_access_key=_optional(values, "AWS_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY", "S3_SECRET_KEY", "R2_SECRET_ACCESS_KEY"),
            failed_stream=_optional(values, "VIDEO_FAILED_STREAM"),
            stale_pending_ms=int(values.get("VIDEO_STALE_PENDING_MS", "600000")),
            ack_failed_jobs=_bool(values.get("VIDEO_ACK_FAILED_JOBS", "true")),
            video_encoder=parse_encoder(values.get("VIDEO_ENCODER")),
            min_duration_ms=int(values.get("VIDEO_MIN_DURATION_MS") or 1000),
            max_duration_ms=int(values.get("VIDEO_MAX_DURATION_MS") or 180_000),
            max_attempts=max(1, int(values.get("VIDEO_MAX_ATTEMPTS") or 3)),
            retry_backoff_seconds=max(0.0, float(values.get("VIDEO_RETRY_BACKOFF_SECONDS") or 5)),
            worker_id=(values.get("VIDEO_WORKER_ID") or "").strip() or default_worker_id(),
            lease_seconds=max(10, int(values.get("VIDEO_LEASE_SECONDS") or 120)),
            poll_interval_seconds=max(0.1, float(values.get("VIDEO_POLL_INTERVAL_SECONDS") or 2)),
            wakeup_channel=values.get("VIDEO_WAKEUP_CHANNEL") or "video:jobs:wakeup",
            retry_backoff_max_seconds=max(0.0, float(values.get("VIDEO_RETRY_BACKOFF_MAX_SECONDS") or 900)),
            heartbeat_file=Path(values.get("VIDEO_HEARTBEAT_FILE") or "/tmp/video-worker-heartbeat"),
            shutdown_mode=parse_shutdown_mode(values.get("VIDEO_SHUTDOWN_MODE")),
        )


QUEUE_BACKENDS = ("postgres", "stream", "list")
SHUTDOWN_MODES = ("release", "finish")


def default_worker_id() -> str:
    """Unic între hosturi/containere: `host:pid:hex6`."""
    return f"{socket.gethostname() or 'video-worker'}:{os.getpid()}:{uuid.uuid4().hex[:6]}"


def parse_queue_backend(value: str | None) -> str:
    backend = (value or "postgres").strip().lower()
    if backend not in QUEUE_BACKENDS:
        raise ValueError(f"Unsupported VIDEO_QUEUE_BACKEND {value!r}; expected one of {', '.join(QUEUE_BACKENDS)}")
    return backend


def parse_shutdown_mode(value: str | None) -> str:
    mode = (value or "release").strip().lower()
    if mode not in SHUTDOWN_MODES:
        raise ValueError(f"Unsupported VIDEO_SHUTDOWN_MODE {value!r}; expected one of {', '.join(SHUTDOWN_MODES)}")
    return mode


def parse_ladder(value: str | None) -> list[LadderRung]:
    """`VIDEO_LADDER="360:800k,720:2800k"` → trepte sortate crescător după latura scurtă."""
    if not value or not value.strip():
        value = DEFAULT_LADDER

    rungs: list[LadderRung] = []
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            continue
        try:
            short_raw, bitrate = part.split(":", 1)
            short = int(short_raw)
        except ValueError as exc:
            raise ValueError("VIDEO_LADDER entries must look like '720:2800k'") from exc
        bitrate = bitrate.strip()
        if short < 2 or not bitrate:
            raise ValueError(f"Invalid VIDEO_LADDER entry: {part!r}")
        rungs.append(LadderRung(short=short - short % 2, bitrate=bitrate))

    if not rungs:
        raise ValueError("VIDEO_LADDER must define at least one rung")
    return sorted(rungs, key=lambda rung: rung.short)


def parse_encoder(value: str | None) -> str:
    encoder = (value or "libx264").strip().lower()
    if encoder not in SUPPORTED_ENCODERS:
        raise ValueError(
            f"Unsupported VIDEO_ENCODER {value!r}; expected one of {', '.join(SUPPORTED_ENCODERS)}"
        )
    return encoder


def _optional(values: Mapping[str, str], *keys: str) -> str | None:
    for key in keys:
        value = values.get(key)
        if value:
            return value
    return None


def _bool(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}
