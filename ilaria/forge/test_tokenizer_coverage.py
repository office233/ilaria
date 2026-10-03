from __future__ import annotations

import json

import pytest

from data_contract import atomic_write_json, canonical_json_sha256
from first_party_attestation import build_attestation_template
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


def _signed_attestation(root, paths):
    data = build_attestation_template(root, paths=paths)
    data.update(
        {
            "ownership_attested": True,
            "attested_by": "fixture-owner",
            "review_ref": "fixture-review",
        }
    )
    unhashed = dict(data)
    unhashed.pop("attestation_sha256", None)
    data["attestation_sha256"] = canonical_json_sha256(unhashed)
    path = root.parent / "first-party.attestation.json"
    atomic_write_json(path, data)
    return path


def test_coverage_manifest_accepts_attested_first_party_copy(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "protocol.swyp"
    source.write_text("record ToolCall {}\n", encoding="utf-8")
    attestation = _signed_attestation(workspace, ["protocol.swyp"])
    production = tmp_path / "production"
    production.mkdir()
    copied = production / "protocol.swyp"
    copied.write_bytes(source.read_bytes())
    rights = approved_rights(tmp_path)
    entries = {
        category: [(copied, "first_party_contracts")]
        for category in REQUIRED_COVERAGE
    }
    manifest = build_coverage_manifest(
        entries,
        rights_registry_path=rights,
        first_party_attestations={"first_party_contracts": attestation},
        first_party_root=workspace,
    )
    path = production / "coverage.json"
    atomic_write_json(path, manifest)
    assert (
        manifest["coverage"]["tools_protocol"]["files"][0]["attested_path"]
        == "protocol.swyp"
    )
    assert validate_coverage_manifest(
        path,
        rights_registry_path=rights,
        first_party_attestations={"first_party_contracts": attestation},
        first_party_root=workspace,
    ) == manifest


def test_coverage_manifest_rejects_unsigned_first_party(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "protocol.swyp"
    source.write_text("record ToolCall {}\n", encoding="utf-8")
    data = build_attestation_template(workspace, paths=["protocol.swyp"])
    attestation = tmp_path / "first-party.attestation.json"
    atomic_write_json(attestation, data)
    rights = approved_rights(tmp_path)
    entries = {
        category: [(source, "first_party_contracts")]
        for category in REQUIRED_COVERAGE
    }
    with pytest.raises(ValueError, match="ownership is not attested"):
        build_coverage_manifest(
            entries,
            rights_registry_path=rights,
            first_party_attestations={"first_party_contracts": attestation},
            first_party_root=workspace,
        )
