"""Shared immutable-data contracts for the Ilaria Forge."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

try:
    from .atomic_io import atomic_binary_writer
except ImportError:  # direct script execution
    from atomic_io import atomic_binary_writer

CORPUS_MANIFEST_SCHEMA = 2
TOKEN_STREAM_FORMAT = "ilaria-token-stream-v1"
DATASET_MANIFEST_SCHEMA = 1
RIGHTS_REGISTRY_SCHEMA = 1

RIGHTS_APPROVED = "APPROVED"
RIGHTS_REVIEW_REQUIRED = "REVIEW_REQUIRED"
RIGHTS_REJECTED = "REJECTED"


def sha256_file(path: str | os.PathLike[str]) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def canonical_json_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def atomic_write_json(
    path: str | os.PathLike[str],
    value: object,
    *,
    pretty: bool = True,
) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        payload = json.dumps(
            value, sort_keys=True, indent=2, ensure_ascii=False
        ).encode("utf-8") + b"\n"
    else:
        payload = canonical_json_bytes(value) + b"\n"
    with atomic_binary_writer(destination) as stream:
        stream.write(payload)


def require_lower_sha256(field: str, value: str) -> None:
    if not isinstance(value, str) or len(value) != 64 or value.lower() != value:
        raise ValueError(f"{field} must be a lowercase SHA-256 hex digest")
    try:
        decoded = bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError(
            f"{field} must be a lowercase SHA-256 hex digest"
        ) from exc
    if len(decoded) != 32:
        raise ValueError(f"{field} must be a lowercase SHA-256 hex digest")


def load_rights_registry(path: str | os.PathLike[str]) -> dict:
    with open(path, encoding="utf-8") as stream:
        data = json.load(stream)
    if data.get("schema_version") != RIGHTS_REGISTRY_SCHEMA:
        raise ValueError("unsupported rights registry schema")
    sources = data.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("rights registry has no sources")
    return data


def require_approved_rights(registry: dict, source_names: list[str]) -> None:
    sources = registry["sources"]
    for name in source_names:
        entry = sources.get(name)
        if not isinstance(entry, dict):
            raise ValueError(f"rights registry has no entry for {name!r}")
        if entry.get("status") != RIGHTS_APPROVED:
            raise ValueError(
                f"source {name!r} is not approved for training "
                f"(status={entry.get('status')!r})"
            )
        if entry.get("commercial_use_approved") is not True:
            raise ValueError(
                f"source {name!r} is not approved for commercial use"
            )
        if not str(entry.get("review_ref", "")).strip():
            raise ValueError(
                f"source {name!r} has no rights review reference"
            )
