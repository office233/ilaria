from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from corpus_source_lock import build_source_lock, load_source_lock, validate_source_lock


@dataclass(frozen=True)
class Spec:
    hf_id: str
    config: str | None


SPECS = {
    "a": Spec("owner/dataset-a", None),
    "b": Spec("owner/dataset-b", "ro"),
}


def revisions():
    return {"a": "a" * 40, "b": "b" * 40}


def test_source_lock_is_deterministic_and_valid():
    one = build_source_lock(SPECS, revisions())
    two = build_source_lock(dict(reversed(list(SPECS.items()))), revisions())
    assert one == two
    assert validate_source_lock(one, SPECS) == one


def test_source_lock_rejects_provider_drift():
    lock = build_source_lock(SPECS, revisions())
    lock["sources"]["a"]["provider"] = "other/dataset"
    with pytest.raises(ValueError, match="identity hash mismatch|provider mismatch"):
        validate_source_lock(lock, SPECS)


def test_source_lock_rejects_non_sha_revision():
    with pytest.raises(ValueError, match="revision"):
        build_source_lock(SPECS, {"a": "main", "b": "b" * 40})


def test_source_lock_file_round_trip(tmp_path):
    lock = build_source_lock(SPECS, revisions())
    path = tmp_path / "sources.lock.json"
    path.write_text(json.dumps(lock), encoding="utf-8")
    assert load_source_lock(path, SPECS) == lock
