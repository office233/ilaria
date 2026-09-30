"""Immutable Hugging Face source revision locks for production corpus builds."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Mapping

from data_contract import atomic_write_json, canonical_json_sha256, require_lower_sha256

SOURCE_LOCK_FORMAT = "ilaria-corpus-source-lock-v1"


def _require_hf_revision(name: str, value: str) -> str:
    if not isinstance(value, str) or len(value) != 40 or value.lower() != value:
        raise ValueError(f"{name} must be a lowercase 40-hex Hugging Face commit SHA")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError(
            f"{name} must be a lowercase 40-hex Hugging Face commit SHA"
        ) from exc
    return value


def _identity_hash(lock: dict) -> str:
    payload = dict(lock)
    payload.pop("source_lock_sha256", None)
    return canonical_json_sha256(payload)


def build_source_lock(specs: Mapping[str, object], revisions: Mapping[str, str]) -> dict:
    """Build a deterministic lock from source specs and exact repository SHAs."""
    if not specs:
        raise ValueError("source lock requires at least one source")
    entries = {}
    for name in sorted(specs):
        spec = specs[name]
        revision = revisions.get(name, "")
        _require_hf_revision(f"source {name} revision", revision)
        provider = getattr(spec, "hf_id", "")
        config = getattr(spec, "config", None)
        if not isinstance(provider, str) or not provider:
            raise ValueError(f"source {name!r} has no provider")
        entries[name] = {
            "provider": provider,
            "config": config,
            "revision": revision,
        }
    lock = {"format": SOURCE_LOCK_FORMAT, "sources": entries}
    lock["source_lock_sha256"] = _identity_hash(lock)
    return lock


def validate_source_lock(lock: dict, specs: Mapping[str, object]) -> dict:
    if not isinstance(lock, dict) or lock.get("format") != SOURCE_LOCK_FORMAT:
        raise ValueError("unsupported corpus source lock format")
    declared = lock.get("source_lock_sha256", "")
    require_lower_sha256("source_lock_sha256", declared)
    if _identity_hash(lock) != declared:
        raise ValueError("corpus source lock identity hash mismatch")
    entries = lock.get("sources")
    if not isinstance(entries, dict) or not entries:
        raise ValueError("corpus source lock has no sources")
    for name, entry in entries.items():
        if name not in specs:
            raise ValueError(f"source lock contains unknown source {name!r}")
        if not isinstance(entry, dict):
            raise ValueError(f"source lock entry {name!r} is invalid")
        spec = specs[name]
        if entry.get("provider") != getattr(spec, "hf_id", None):
            raise ValueError(f"source lock provider mismatch for {name!r}")
        if entry.get("config") != getattr(spec, "config", None):
            raise ValueError(f"source lock config mismatch for {name!r}")
        _require_hf_revision(
            f"source {name} revision", str(entry.get("revision", ""))
        )
    return lock


def load_source_lock(path: str | Path, specs: Mapping[str, object]) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        data = json.load(stream)
    return validate_source_lock(data, specs)


def resolve_huggingface_revisions(specs: Mapping[str, object]) -> dict[str, str]:
    """Resolve current upstream repository heads once; callers persist the lock."""
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise RuntimeError("huggingface_hub is required to resolve corpus revisions") from exc
    api = HfApi()
    revisions: dict[str, str] = {}
    for name in sorted(specs):
        provider = getattr(specs[name], "hf_id", "")
        info = api.dataset_info(provider, revision="main")
        revision = str(info.sha or "")
        _require_hf_revision(f"source {name} revision", revision)
        revisions[name] = revision
    return revisions


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--source", action="append", default=[])
    resolve.add_argument("--out", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--lock", required=True)
    args = parser.parse_args()

    from prepare_corpus import SOURCES

    if args.command == "resolve":
        names = args.source or sorted(SOURCES)
        unknown = sorted(set(names) - set(SOURCES))
        if unknown:
            raise ValueError(f"unknown corpus sources: {unknown}")
        specs = {name: SOURCES[name] for name in names}
        lock = build_source_lock(specs, resolve_huggingface_revisions(specs))
        atomic_write_json(args.out, lock)
        print(f"[corpus-lock] {args.out}: {lock['source_lock_sha256']}")
    else:
        lock = load_source_lock(args.lock, SOURCES)
        print(f"[corpus-lock] valid: {lock['source_lock_sha256']}")


if __name__ == "__main__":
    main()
