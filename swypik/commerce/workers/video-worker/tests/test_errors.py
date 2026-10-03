import socket

import pytest

from video_worker.errors import (
    FfmpegMissingError,
    FfmpegTimeoutError,
    PermanentJobError,
    classify_error,
)


class EndpointConnectionError(Exception):
    """Imită botocore.exceptions.EndpointConnectionError (fără dependență)."""


class ClientError(Exception):
    pass


class ReadTimeoutError(Exception):
    pass


class StorageUnavailableError(RuntimeError):
    pass


@pytest.mark.parametrize(
    "exc,expected",
    [
        (PermanentJobError("duration_too_long"), ("duration_too_long", False)),
        (PermanentJobError("no_video_stream", "details"), ("no_video_stream", False)),
        (FfmpegMissingError("no ffmpeg"), ("worker_misconfigured", False)),
        (FfmpegTimeoutError("slow"), ("timeout", False)),
        (RuntimeError("ffmpeg command failed: moov atom not found"), ("transcode_failed", False)),
        (ConnectionError("reset"), ("storage_error", True)),
        (TimeoutError("slow network"), ("storage_error", True)),
        (socket.gaierror("dns"), ("storage_error", True)),
        (EndpointConnectionError("r2 down"), ("storage_error", True)),
        (ClientError("503 SlowDown"), ("storage_error", True)),
        (ReadTimeoutError("read timeout"), ("storage_error", True)),
        (StorageUnavailableError("boto3 missing"), ("worker_misconfigured", False)),
        (RuntimeError("something odd"), ("internal_error", True)),
        (ValueError("bug"), ("internal_error", True)),
    ],
)
def test_classify_error(exc, expected):
    assert classify_error(exc) == expected


def test_permanent_error_message_defaults_to_code():
    assert str(PermanentJobError("invalid_source")) == "invalid_source"
