from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_contract import canonical_json_sha256
from rights_evidence import load_and_validate_evidence, require_approved_evidence


CONFIG = Path(__file__).resolve().parent / "config"


def fixture(tmp_path):
    lock = {
        "format": "ilaria-corpus-source-lock-v1",
        "sources": {
            "source_a": {
                "provider": "owner/a",
                "config": None,
                "revision": "b" * 40,
            }
        },
    }
    lock["source_lock_sha256"] = canonical_json_sha256(lock)
    lock_path = tmp_path / "sources.lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    rights = {
        "schema_version": 1,
        "policy": "fixture",
        "evidence": {
            "filename": "evidence.json",
            "sha256": "PENDING",
            "source_lock_sha256": lock["source_lock_sha256"],
        },
        "sources": {
            "source_a": {
                "status": "REVIEW_REQUIRED",
                "commercial_use_approved": False,
                "review_ref": "",
            }
        },
    }
    rights_path = tmp_path / "rights.json"
    rights_path.write_text(json.dumps(rights), encoding="utf-8")
    evidence = {
        "format": "ilaria-rights-evidence-v1",
        "source_lock_sha256": lock["source_lock_sha256"],
        "sources": {
            "source_a": {
                **lock["sources"]["source_a"],
                "declared_license": "TEST-1.0",
                "review_state": "EVIDENCE_COLLECTED",
                "evidence_urls": ["https://example.com/license"],
                "unresolved_obligations": ["manual review required"],
            }
        },
    }
    evidence["evidence_sha256"] = canonical_json_sha256(evidence)
    rights["evidence"]["sha256"] = evidence["evidence_sha256"]
    rights_path.write_text(json.dumps(rights), encoding="utf-8")
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    return evidence_path, lock_path, rights_path, evidence


def test_rights_evidence_validates_against_lock_and_registry(tmp_path):
    evidence_path, lock_path, rights_path, evidence = fixture(tmp_path)
    assert load_and_validate_evidence(
        evidence_path,
        source_lock_path=lock_path,
        rights_registry_path=rights_path,
    ) == evidence


def test_rights_evidence_rejects_revision_drift(tmp_path):
    evidence_path, lock_path, rights_path, evidence = fixture(tmp_path)
    evidence["sources"]["source_a"]["revision"] = "c" * 40
    evidence["evidence_sha256"] = canonical_json_sha256(
        {k: v for k, v in evidence.items() if k != "evidence_sha256"}
    )
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    rights = json.loads(rights_path.read_text(encoding="utf-8"))
    rights["evidence"]["sha256"] = evidence["evidence_sha256"]
    rights_path.write_text(json.dumps(rights), encoding="utf-8")
    with pytest.raises(ValueError, match="revision mismatch"):
        load_and_validate_evidence(
            evidence_path,
            source_lock_path=lock_path,
            rights_registry_path=rights_path,
        )


def test_rights_evidence_rejects_registry_source_drift(tmp_path):
    evidence_path, lock_path, rights_path, _ = fixture(tmp_path)
    rights = json.loads(rights_path.read_text(encoding="utf-8"))
    rights["sources"]["source_b"] = dict(rights["sources"]["source_a"])
    rights_path.write_text(json.dumps(rights), encoding="utf-8")
    with pytest.raises(ValueError, match="source set differs"):
        load_and_validate_evidence(
            evidence_path,
            source_lock_path=lock_path,
            rights_registry_path=rights_path,
        )


def test_registry_approval_requires_closed_approved_evidence(tmp_path):
    evidence_path, lock_path, rights_path, _ = fixture(tmp_path)
    evidence = load_and_validate_evidence(
        evidence_path,
        source_lock_path=lock_path,
        rights_registry_path=rights_path,
    )
    registry = json.loads(rights_path.read_text(encoding="utf-8"))
    registry["sources"]["source_a"].update(
        {
            "status": "APPROVED",
            "commercial_use_approved": True,
            "review_ref": "review-1",
            "declared_license": "TEST-1.0",
        }
    )
    with pytest.raises(ValueError, match="evidence is not APPROVED"):
        require_approved_evidence(registry, evidence, ["source_a"])

    evidence["sources"]["source_a"]["review_state"] = "APPROVED"
    with pytest.raises(ValueError, match="unresolved rights obligations"):
        require_approved_evidence(registry, evidence, ["source_a"])

    evidence["sources"]["source_a"]["unresolved_obligations"] = []
    require_approved_evidence(registry, evidence, ["source_a"])


def test_canonical_rights_evidence_and_source_locks_validate_together():
    evidence = load_and_validate_evidence(
        CONFIG / "data_rights_evidence.json",
        source_lock_path=CONFIG / "corpus_sources.lock.json",
        rights_registry_path=CONFIG / "data_rights.json",
    )
    assert evidence["git_source_lock_sha256"]
    assert evidence["sources"]["zephyr"]["source_kind"] == "git"
    assert evidence["sources"]["zephyr"]["review_state"] == "APPROVED"
    assert evidence["sources"]["zephyr"]["unresolved_obligations"] == []
