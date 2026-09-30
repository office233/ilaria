from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_contract import atomic_write_json  # noqa: E402
from git_source_lock import build_lock as build_git_source_lock  # noqa: E402
from tokenizer_freeze import (  # noqa: E402
    REQUIRED_COVERAGE,
    build_freeze_manifest,
    build_sample_manifest,
    validate_freeze_manifest,
    validate_sample_manifest,
)
from corpus_source_lock import build_source_lock  # noqa: E402
from prepare_corpus import SOURCES  # noqa: E402


def rights_fixture(tmp_path: Path, *, approved: bool = True) -> Path:
    path = tmp_path / "rights.json"
    atomic_write_json(
        path,
        {
            "schema_version": 1,
            "policy": "fixture-rights-v1",
            "sources": {
                "fixture_first_party": {
                    "status": "APPROVED" if approved else "REVIEW_REQUIRED",
                    "commercial_use_approved": approved,
                    "review_ref": "fixture-review" if approved else "",
                }
            },
        },
    )
    return path


def sample_fixture(tmp_path: Path, *, approved: bool = True):
    sample = tmp_path / "tokenizer_sample.txt"
    sample.write_text(
        "English text for code() math OS driver CAN USB tool protocol coverage.\n",
        encoding="utf-8",
    )
    rights = rights_fixture(tmp_path, approved=approved)
    manifest = build_sample_manifest(
        [sample],
        source_names=["fixture_first_party"],
        coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=rights,
    )
    manifest_path = tmp_path / "tokenizer_sample.manifest.json"
    atomic_write_json(manifest_path, manifest)
    return sample, rights, manifest_path, manifest


def tokenizer_fixture(tmp_path: Path) -> Path:
    path = tmp_path / "ilarialex.json"
    path.write_text(
        json.dumps(
            {
                "format": "ilarialex-v1",
                "vocab_size": 65536,
                "base_vocab_size": 61440,
                "protocol_reserved": 4096,
                "protocol_start_id": 61440,
                "eos_id": 61440,
                "eos_token": "<|ilaria:eos|>",
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    path.with_suffix(".hf.json").write_text(
        '{"fixture":"hf-tokenizer"}\n', encoding="utf-8"
    )
    return path


def test_sample_manifest_is_deterministic_and_validates(tmp_path):
    _, rights, manifest_path, one = sample_fixture(tmp_path)
    two = validate_sample_manifest(manifest_path, rights_registry_path=rights)
    assert two == one
    assert set(two["coverage"]) >= REQUIRED_COVERAGE
    assert len(two["sample_manifest_sha256"]) == 64


def test_sample_manifest_rejects_missing_required_coverage(tmp_path):
    sample = tmp_path / "sample.txt"
    sample.write_text("enough sample data\n", encoding="utf-8")
    rights = rights_fixture(tmp_path)
    with pytest.raises(ValueError, match="missing required coverage"):
        build_sample_manifest(
            [sample],
            source_names=["fixture_first_party"],
            coverage=["english"],
            rights_registry_path=rights,
        )


def test_sample_manifest_rejects_unapproved_rights(tmp_path):
    sample = tmp_path / "sample.txt"
    sample.write_text("enough sample data\n", encoding="utf-8")
    rights = rights_fixture(tmp_path, approved=False)
    with pytest.raises(ValueError, match="not approved"):
        build_sample_manifest(
            [sample],
            source_names=["fixture_first_party"],
            coverage=sorted(REQUIRED_COVERAGE),
            rights_registry_path=rights,
        )


def test_sample_manifest_detects_input_tampering(tmp_path):
    sample, rights, manifest_path, _ = sample_fixture(tmp_path)
    sample.write_text("tampered\n", encoding="utf-8")
    with pytest.raises(ValueError, match="size mismatch|hash mismatch"):
        validate_sample_manifest(manifest_path, rights_registry_path=rights)


def test_freeze_manifest_pins_tokenizer_sample_and_rights(tmp_path):
    _, rights, sample_manifest_path, sample_manifest = sample_fixture(tmp_path)
    tokenizer = tokenizer_fixture(tmp_path)
    freeze = build_freeze_manifest(
        tokenizer,
        sample_manifest_path=sample_manifest_path,
        rights_registry_path=rights,
    )
    freeze_path = tmp_path / "ilarialex.freeze.json"
    atomic_write_json(freeze_path, freeze)

    validated = validate_freeze_manifest(
        freeze_path, rights_registry_path=rights
    )
    assert validated == freeze
    assert validated["sample"]["sha256"] == sample_manifest["sample_manifest_sha256"]
    assert validated["tokenizer"]["eos_id"] == 61440
    assert len(validated["freeze_sha256"]) == 64


def test_freeze_manifest_detects_tokenizer_tampering(tmp_path):
    _, rights, sample_manifest_path, _ = sample_fixture(tmp_path)
    tokenizer = tokenizer_fixture(tmp_path)
    freeze = build_freeze_manifest(
        tokenizer,
        sample_manifest_path=sample_manifest_path,
        rights_registry_path=rights,
    )
    freeze_path = tmp_path / "ilarialex.freeze.json"
    atomic_write_json(freeze_path, freeze)
    tokenizer.write_text('{"tampered":true}\n', encoding="utf-8")

    with pytest.raises(ValueError):
        validate_freeze_manifest(freeze_path, rights_registry_path=rights)


def test_sample_and_freeze_pin_exact_source_lock(tmp_path):
    sample = tmp_path / "tokenizer_sample.txt"
    sample.write_text(
        "English code math science OS driver hardware tool protocol text.\n",
        encoding="utf-8",
    )
    rights = tmp_path / "rights.json"
    atomic_write_json(
        rights,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                "tinystories": {
                    "status": "APPROVED",
                    "commercial_use_approved": True,
                    "review_ref": "fixture-review",
                }
            },
        },
    )
    lock = build_source_lock(
        {"tinystories": SOURCES["tinystories"]},
        {"tinystories": "a" * 40},
    )
    lock_path = tmp_path / "corpus_sources.lock.json"
    atomic_write_json(lock_path, lock)
    manifest = build_sample_manifest(
        [sample],
        source_names=["tinystories"],
        coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=rights,
        source_lock_path=lock_path,
    )
    assert manifest["source_lock"]["identity_sha256"] == lock["source_lock_sha256"]
    assert manifest["source_lock"]["sources"]["tinystories"]["revision"] == "a" * 40

    manifest_path = tmp_path / "tokenizer_sample.manifest.json"
    atomic_write_json(manifest_path, manifest)
    tokenizer = tokenizer_fixture(tmp_path)
    freeze = build_freeze_manifest(
        tokenizer,
        sample_manifest_path=manifest_path,
        rights_registry_path=rights,
    )
    assert freeze["sample"]["source_lock"] == manifest["source_lock"]


def test_sample_and_freeze_pin_hf_and_git_source_locks(tmp_path):
    sample = tmp_path / "tokenizer_sample.txt"
    sample.write_text(
        "English code math science OS driver hardware tool protocol text.\n",
        encoding="utf-8",
    )
    rights = tmp_path / "rights.json"
    atomic_write_json(
        rights,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                "tinystories": {
                    "status": "APPROVED",
                    "commercial_use_approved": True,
                    "review_ref": "fixture-review-hf",
                },
                "zephyr": {
                    "status": "APPROVED",
                    "commercial_use_approved": True,
                    "review_ref": "fixture-review-git",
                },
            },
        },
    )
    hf_lock = build_source_lock(
        {"tinystories": SOURCES["tinystories"]},
        {"tinystories": "a" * 40},
    )
    hf_lock_path = tmp_path / "corpus_sources.lock.json"
    atomic_write_json(hf_lock_path, hf_lock)
    git_lock = build_git_source_lock(
        {
            "zephyr": {
                "url": "https://github.com/zephyrproject-rtos/zephyr.git",
                "ref": "main",
                "commit": "b" * 40,
            }
        }
    )
    git_lock_path = tmp_path / "git_sources.lock.json"
    atomic_write_json(git_lock_path, git_lock)

    manifest = build_sample_manifest(
        [sample],
        source_names=["tinystories", "zephyr"],
        coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=rights,
        source_lock_path=hf_lock_path,
        git_source_lock_path=git_lock_path,
    )
    assert set(manifest["source_lock"]["sources"]) == {"tinystories"}
    assert set(manifest["git_source_lock"]["sources"]) == {"zephyr"}
    assert manifest["git_source_lock"]["sources"]["zephyr"]["commit"] == "b" * 40

    manifest_path = tmp_path / "tokenizer_sample.manifest.json"
    atomic_write_json(manifest_path, manifest)
    tokenizer = tokenizer_fixture(tmp_path)
    freeze = build_freeze_manifest(
        tokenizer,
        sample_manifest_path=manifest_path,
        rights_registry_path=rights,
    )
    assert freeze["sample"]["source_lock"] == manifest["source_lock"]
    assert freeze["sample"]["git_source_lock"] == manifest["git_source_lock"]
