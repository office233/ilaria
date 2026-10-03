from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping

from .config import Settings
from .models import InvalidJobPayload, VideoJob

logger = logging.getLogger(__name__)


class QueueUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class QueuedVideoJob:
    job: VideoJob
    message_id: str | None = None
    stream: str | None = None
    raw_payload: Mapping[str, Any] | bytes | str | None = None


def _discard_poison_message(client, stream: str, group: str, message_id: str | None) -> None:
    """ACK + XDEL a corrupted stream entry so it never replays.

    Used when payload fails to decode (e.g. empty string, non-JSON).
    Failures here are non-fatal ? we just log and move on.
    """
    if not message_id:
        return
    try:
        client.xack(stream, group, message_id)
    except Exception:
        logger.warning("xack failed for poison message id=%s", message_id, exc_info=True)
    try:
        client.xdel(stream, message_id)
    except Exception:
        logger.warning("xdel failed for poison message id=%s", message_id, exc_info=True)


class RedisQueue:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None
        self._stream_group_ready = False
        self._pending_start_id = "0-0"

    @property
    def client(self):
        if self._client is None:
            if not self.settings.redis_url:
                raise QueueUnavailableError("REDIS_URL is not configured; worker will not poll jobs")
            try:
                import redis
            except ImportError as exc:
                raise QueueUnavailableError(
                    "redis is not installed; install requirements.txt to enable Redis polling"
                ) from exc
            self._client = redis.Redis.from_url(self.settings.redis_url)
        return self._client

    def pop(self) -> VideoJob | None:
        queued = self.pop_message()
        return queued.job if queued else None

    def pop_message(self) -> QueuedVideoJob | None:
        if self.settings.queue_backend == "list":
            return self._pop_list_message()
        if self.settings.queue_backend != "stream":
            raise QueueUnavailableError(f"Unsupported VIDEO_QUEUE_BACKEND: {self.settings.queue_backend}")
        return self._pop_stream_message()

    def ack(self, queued: QueuedVideoJob) -> None:
        if not queued.message_id or not queued.stream:
            return
        self.client.xack(queued.stream, self.settings.consumer_group, queued.message_id)
        # Also delete the entry from the stream so XLEN stays bounded. XACK only
        # marks the message as processed by the group but leaves it in the stream
        # forever — XDEL physically removes it. Failures here are non-fatal.
        try:
            self.client.xdel(queued.stream, queued.message_id)
        except Exception:
            pass

    def trim(self, max_len: int = 5000) -> None:
        """Cap the main stream length so dangling/unacked entries can't grow
        forever. Best-effort, called periodically by the worker main loop."""
        try:
            self.client.xtrim(self.settings.queue_name, maxlen=max_len, approximate=True)
        except Exception:
            pass

    def fail(self, queued: QueuedVideoJob, message: str) -> None:
        if queued.message_id and self.settings.failed_stream:
            self.client.xadd(
                self.settings.failed_stream,
                {
                    "source_stream": queued.stream or self.settings.queue_name,
                    "source_message_id": queued.message_id,
                    "error": message,
                },
            )
        if self.settings.ack_failed_jobs:
            self.ack(queued)

    def _pop_list_message(self) -> QueuedVideoJob | None:
        item = self.client.blpop(self.settings.queue_name, timeout=self.settings.poll_timeout_seconds)
        if item is None:
            return None
        _, payload = item
        return QueuedVideoJob(job=VideoJob.from_payload(payload), raw_payload=payload)

    def _pop_stream_message(self) -> QueuedVideoJob | None:
        self._ensure_stream_group()
        stale = self._pop_stale_stream_message()
        if stale is not None:
            return stale
        messages = self.client.xreadgroup(
            groupname=self.settings.consumer_group,
            consumername=self.settings.consumer_name,
            streams={self.settings.queue_name: ">"},
            count=1,
            block=self.settings.poll_timeout_seconds * 1000,
        )
        if not messages:
            return None

        for stream, entries in messages:
            stream_name = _decode_value(stream)
            for message_id, fields in entries:
                decoded_fields = _decode_mapping(fields)
                payload = _payload_from_stream_fields(decoded_fields)
                msg_id = _decode_value(message_id)
                try:
                    job = VideoJob.from_payload(payload)
                except InvalidJobPayload as exc:
                    logger.warning(
                        "Discarding poison message id=%s on stream=%s: %s | raw=%r",
                        msg_id, stream_name, exc, decoded_fields,
                    )
                    _discard_poison_message(self.client, stream_name, self.settings.consumer_group, msg_id)
                    continue
                return QueuedVideoJob(
                    job=job,
                    message_id=msg_id,
                    stream=stream_name,
                    raw_payload=decoded_fields,
                )
        return None

    def _pop_stale_stream_message(self) -> QueuedVideoJob | None:
        if self.settings.stale_pending_ms <= 0:
            return None
        try:
            if hasattr(self.client, "xautoclaim"):
                result = self.client.xautoclaim(
                    name=self.settings.queue_name,
                    groupname=self.settings.consumer_group,
                    consumername=self.settings.consumer_name,
                    min_idle_time=self.settings.stale_pending_ms,
                    start_id=self._pending_start_id,
                    count=1,
                )
            elif hasattr(self.client, "execute_command"):
                result = self.client.execute_command(
                    "XAUTOCLAIM",
                    self.settings.queue_name,
                    self.settings.consumer_group,
                    self.settings.consumer_name,
                    self.settings.stale_pending_ms,
                    self._pending_start_id,
                    "COUNT",
                    1,
                )
            else:
                return None
        except TypeError:
            if not hasattr(self.client, "execute_command"):
                return None
            result = self.client.execute_command(
                "XAUTOCLAIM",
                self.settings.queue_name,
                self.settings.consumer_group,
                self.settings.consumer_name,
                self.settings.stale_pending_ms,
                self._pending_start_id,
                "COUNT",
                1,
            )
        except Exception as exc:
            if "unknown command" in str(exc).lower():
                return None
            raise

        next_start_id, entries = _parse_xautoclaim(result)
        self._pending_start_id = str(_decode_value(next_start_id) or "0-0")
        if not entries:
            return None

        for message_id, fields in entries:
            decoded_fields = _decode_mapping(fields)
            payload = _payload_from_stream_fields(decoded_fields)
            msg_id = _decode_value(message_id)
            try:
                job = VideoJob.from_payload(payload)
            except InvalidJobPayload as exc:
                logger.warning(
                    "Discarding poison stale message id=%s on stream=%s: %s | raw=%r",
                    msg_id, self.settings.queue_name, exc, decoded_fields,
                )
                _discard_poison_message(self.client, self.settings.queue_name, self.settings.consumer_group, msg_id)
                continue
            return QueuedVideoJob(
                job=job,
                message_id=msg_id,
                stream=self.settings.queue_name,
                raw_payload=decoded_fields,
            )
        return None

    def _ensure_stream_group(self) -> None:
        if self._stream_group_ready:
            return
        try:
            self.client.xgroup_create(
                name=self.settings.queue_name,
                groupname=self.settings.consumer_group,
                id="0",
                mkstream=True,
            )
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise
        self._stream_group_ready = True


def _payload_from_stream_fields(fields: Mapping[str, Any]) -> Mapping[str, Any] | str | bytes:
    payload = fields.get("payload")
    if payload is not None and len(fields) == 1:
        return payload
    data = fields.get("data")
    if data is not None and len(fields) == 1:
        return data
    return fields


def _decode_mapping(fields: Mapping[Any, Any]) -> dict[str, Any]:
    return {str(_decode_value(key)): _decode_value(value) for key, value in fields.items()}


def _parse_xautoclaim(result: Any) -> tuple[Any, list[tuple[Any, Mapping[Any, Any]]]]:
    if isinstance(result, (list, tuple)) and len(result) >= 2:
        return result[0], list(result[1] or [])
    return "0-0", []


def _decode_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value
