from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping


class InvalidAiJobPayload(ValueError):
    pass


@dataclass(frozen=True)
class AiJob:
    job_id: str
    asset_id: str
    media_key: str
    tasks: tuple[str, ...]
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: bytes | str | Mapping[str, Any]) -> "AiJob":
        data = _decode_payload(payload)
        job_id = _first(data, "job_id", "jobId", "id")
        asset_id = _first(data, "asset_id", "assetId", "video_asset_id", "videoAssetId")
        media_key = _first(data, "media_key", "mediaKey", "hls_key", "source_key", "object_key")
        tasks = _tasks(_first(data, "tasks", "task"))
        metadata = _metadata(_first(data, "metadata", "meta"))

        missing = [
            name
            for name, value in (
                ("job_id", job_id),
                ("asset_id", asset_id),
                ("media_key", media_key),
                ("tasks", tasks),
            )
            if not value
        ]
        if missing:
            raise InvalidAiJobPayload(f"AI job payload is missing: {', '.join(missing)}")

        return cls(
            job_id=str(job_id),
            asset_id=str(asset_id),
            media_key=str(media_key),
            tasks=tasks,
            metadata=metadata,
        )


def _decode_payload(payload: bytes | str | Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(payload, Mapping):
        normalized = _normalize_mapping(payload)
    else:
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise InvalidAiJobPayload("AI job payload must be valid JSON") from exc
        if not isinstance(decoded, Mapping):
            raise InvalidAiJobPayload("AI job payload must be a JSON object")
        normalized = _normalize_mapping(decoded)

    stream_payload = normalized.get("payload")
    if stream_payload is not None and len(normalized) == 1:
        return _decode_payload(stream_payload)
    return normalized


def _first(data: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def _tasks(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("["):
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise InvalidAiJobPayload("tasks must be a JSON array or comma-separated string") from exc
        else:
            value = [part.strip() for part in stripped.split(",")]
    if not isinstance(value, (list, tuple)):
        raise InvalidAiJobPayload("tasks must be a list")
    return tuple(str(task) for task in value if str(task).strip())


def _metadata(value: Any) -> Mapping[str, Any]:
    if value in (None, ""):
        return {}
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise InvalidAiJobPayload("metadata must be a JSON object") from exc
    if not isinstance(value, Mapping):
        raise InvalidAiJobPayload("metadata must be an object")
    return _normalize_mapping(value)


def _normalize_mapping(data: Mapping[Any, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(key, bytes):
            key = key.decode("utf-8")
        normalized[str(key)] = _normalize_value(value)
    return normalized


def _normalize_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if isinstance(value, Mapping):
        return _normalize_mapping(value)
    return value
