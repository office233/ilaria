from __future__ import annotations

import json

import pytest

from data_contract import canonical_json_sha256
from first_party_attestation import build_attestation_template, validate_attestation


def test_template_is_unsigned_and_pins_file_hashes(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "spec.swyp").write_text("record Test {}\n", encoding="utf-8")
    data = build_attestation_template(root, paths=["spec.swyp"])
    assert data["ownership_attested"] is False
    assert len(data["files"][0]["sha256"]) == 64


def test_validation_requires_explicit_ownership_attestation(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "spec.swyp").write_text("record Test {}\n", encoding="utf-8")
    data = build_attestation_template(root, paths=["spec.swyp"])
    path = tmp_path / "attestation.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="ownership is not attested"):
        validate_attestation(path, workspace_root=root)


def test_signed_manual_attestation_detects_file_tampering(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "spec.swyp"
    target.write_text("record Test {}\n", encoding="utf-8")
    data = build_attestation_template(root, paths=["spec.swyp"])
    data.update(
        {
            "ownership_attested": True,
            "attested_by": "owner@example.test",
            "review_ref": "manual-owner-review-1",
        }
    )
    unsigned = dict(data)
    unsigned.pop("attestation_sha256", None)
    data["attestation_sha256"] = canonical_json_sha256(unsigned)
    path = tmp_path / "attestation.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert validate_attestation(path, workspace_root=root) == data
    target.write_text("record Changed {}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="hash mismatch"):
        validate_attestation(path, workspace_root=root)
