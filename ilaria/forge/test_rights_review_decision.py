from __future__ import annotations

import copy

import pytest

from data_contract import canonical_json_sha256
from rights_review_decision import apply_decision_packet, validate_decision_packet


def fixture():
    evidence = {
        "format": "ilaria-rights-evidence-v1",
        "source_lock_sha256": "a" * 64,
        "git_source_lock_sha256": "b" * 64,
        "sources": {
            "zephyr": {
                "declared_license": "Apache-2.0",
                "review_state": "EVIDENCE_COLLECTED",
                "unresolved_obligations": ["notice review", "retain provenance"],
            }
        },
    }
    evidence["evidence_sha256"] = canonical_json_sha256(evidence)
    rights = {
        "schema_version": 1,
        "evidence": {"sha256": evidence["evidence_sha256"]},
        "sources": {
            "zephyr": {
                "status": "REVIEW_REQUIRED",
                "commercial_use_approved": False,
                "review_ref": "",
                "declared_license": "Apache-2.0",
            }
        },
    }
    packet = {
        "format": "ilaria-rights-review-decision-v1",
        "evidence_sha256": evidence["evidence_sha256"],
        "source_lock_sha256": evidence["source_lock_sha256"],
        "git_source_lock_sha256": evidence["git_source_lock_sha256"],
        "reviewer": "Legal Reviewer",
        "reviewed_at": "2026-09-29T18:00:00Z",
        "decisions": {
            "zephyr": {
                "decision": "APPROVED",
                "commercial_use_approved": True,
                "review_ref": "LEGAL-2026-001",
                "resolved_obligations": ["notice review", "retain provenance"],
                "notes": "Reviewed Apache-2.0 use and provenance policy.",
            }
        },
    }
    packet["decision_sha256"] = canonical_json_sha256(packet)
    return rights, evidence, packet


def test_approved_decision_must_resolve_every_pinned_obligation():
    rights, evidence, packet = fixture()
    packet["decisions"]["zephyr"]["resolved_obligations"] = ["notice review"]
    packet.pop("decision_sha256")
    packet["decision_sha256"] = canonical_json_sha256(packet)
    with pytest.raises(ValueError, match="resolve every pinned obligation"):
        validate_decision_packet(packet, rights=rights, evidence=evidence)


def test_apply_approved_decision_updates_registry_and_evidence_hash():
    rights, evidence, packet = fixture()
    new_rights, new_evidence = apply_decision_packet(
        packet, rights=rights, evidence=evidence
    )
    assert new_rights["sources"]["zephyr"]["status"] == "APPROVED"
    assert new_rights["sources"]["zephyr"]["commercial_use_approved"] is True
    assert new_evidence["sources"]["zephyr"]["review_state"] == "APPROVED"
    assert new_evidence["sources"]["zephyr"]["unresolved_obligations"] == []
    assert new_rights["evidence"]["sha256"] == new_evidence["evidence_sha256"]


def test_decision_packet_is_bound_to_current_evidence_hash():
    rights, evidence, packet = fixture()
    stale = copy.deepcopy(packet)
    stale["evidence_sha256"] = "c" * 64
    stale.pop("decision_sha256")
    stale["decision_sha256"] = canonical_json_sha256(stale)
    with pytest.raises(ValueError, match="evidence hash mismatch"):
        validate_decision_packet(stale, rights=rights, evidence=evidence)
