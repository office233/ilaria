from __future__ import annotations

import json

import pytest

from data_contract import atomic_write_json
from tokenizer_coverage import (
    REQUIRED_COVERAGE,
    build_coverage_manifest,
    validate_coverage_manifest,
)


def approved_rights(tmp_path):
    path = tmp_path / "rights.json"
    atomic_write_json(
        path,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                "first_party": {
                    "status": "APPROVED",
                    "commercial_use_approved": True,
                    "review_ref": "fixture-review",
                }
            },
        },
    )
    return path


def fixture_entries(tmp_path):
    entries = {}
    for category in sorted(REQUIRED_COVERAGE):
        path = tmp_path / f"{category}.txt"
        path.write_text(f"representative {category} material\n", encoding="utf-8")
        entries[category] = [(path, "first_party")]
    return entries


def test_coverage_manifest_is_deterministic_and_validates(tmp_path):
    rights = approved_rights(tmp_path)
    manifest = build_coverage_manifest(
        fixture_entries(tmp_path), rights_registry_path=rights
    )
    path = tmp_path / "coverage.json"
    atomic_write_json(path, manifest)
    assert validate_coverage_manifest(path, rights_registry_path=rights) == manifest
    assert set(manifest["coverage"]) == REQUIRED_COVERAGE
    assert len(manifest["coverage_sha256"]) == 64


def test_coverage_manifest_rejects_missing_category(tmp_path):
    rights = approved_rights(tmp_path)
    entries = fixture_entries(tmp_path)
    del entries["hardware"]
    with pytest.raises(ValueError, match="coverage set mismatch"):
        build_coverage_manifest(entries, rights_registry_path=rights)


def test_coverage_manifest_rejects_unapproved_source(tmp_path):
    rights = approved_rights(tmp_path)
    data = json.loads(rights.read_text(encoding="utf-8"))
    data["sources"]["first_party"]["status"] = "REVIEW_REQUIRED"
    data["sources"]["first_party"]["commercial_use_approved"] = False
    atomic_write_json(rights, data)
    with pytest.raises(ValueError, match="not approved"):
        build_coverage_manifest(fixture_entries(tmp_path), rights_registry_path=rights)


def test_coverage_manifest_detects_input_tampering(tmp_path):
    rights = approved_rights(tmp_path)
    entries = fixture_entries(tmp_path)
    manifest = build_coverage_manifest(entries, rights_registry_path=rights)
    path = tmp_path / "coverage.json"
    atomic_write_json(path, manifest)
    entries["code"][0][0].write_text("tampered\n", encoding="utf-8")
    with pytest.raises(ValueError, match="size mismatch|hash mismatch"):
        validate_coverage_manifest(path, rights_registry_path=rights)
