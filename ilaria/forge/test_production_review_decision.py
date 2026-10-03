from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from production_review_decision import (
    build_decision_template,
    load_review_packet,
    prepare_reviewed_bundle,
    rehash_decision,
    validate_decision,
)
from test_production_review_packet import canonical_packet as fixture_packet, fixture_attestations
from workspace_paths import benchmark_root


ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(__file__).resolve().parent / "config"
REVIEW_PACKET = benchmark_root(ROOT) / "imc_125m_production_review" / "REVIEW_PACKET.json"


def canonical_packet():
    return load_review_packet(REVIEW_PACKET)


def approved_fixture_decision(packet: dict) -> dict:
    decision = build_decision_template(packet)
    for source, record in decision["external_sources"].items():
        record.update(
            {
                "decision": "APPROVE",
                "reviewed_by": "fixture-reviewer",
                "review_ref": f"fixture-review:{source}",
                "resolved_obligations": list(
                    packet["external_sources"][source]["unresolved_obligations"]
                ),
            }
        )
    for source, record in decision["first_party_sources"].items():
        record.update(
            {
                "decision": "ATTEST",
                "attested_by": "fixture-owner",
                "review_ref": f"fixture-owner-review:{source}",
            }
        )
    return rehash_decision(decision)


def pending_attestation_fixture(tmp_path: Path, packet: dict) -> dict[str, Path]:
    paths = fixture_attestations(tmp_path, attested=False)
    for source, path in paths.items():
        value = json.loads(path.read_text(encoding="utf-8"))
        assert (
            value["attestation_sha256"]
            == packet["first_party_sources"][source]["attestation_sha256"]
        )
    return paths


def test_pending_template_is_content_addressed_and_incomplete():
    packet = canonical_packet()
    decision = build_decision_template(packet)
    report = validate_decision(packet, decision)
    assert report["complete"] is False
    assert report["production_approved"] is False
    assert len(report["external_pending"]) == 8
    assert set(report["first_party_pending"]) == {
        "first_party_contracts",
        "first_party_trajectories",
    }


def test_complete_approval_requires_explicit_resolution_of_every_obligation():
    packet = canonical_packet()
    decision = approved_fixture_decision(packet)
    source = "wiki_en"
    decision = copy.deepcopy(decision)
    decision["external_sources"][source]["resolved_obligations"] = []
    decision = rehash_decision(decision)
    with pytest.raises(ValueError, match="resolve every"):
        validate_decision(packet, decision, require_complete=True)


def test_decision_rejects_review_packet_drift():
    packet = canonical_packet()
    decision = build_decision_template(packet)
    decision["review_packet_sha256"] = "0" * 64
    decision = rehash_decision(decision)
    with pytest.raises(ValueError, match="different review packet"):
        validate_decision(packet, decision)


def test_complete_approved_decision_materializes_separate_valid_bundle(tmp_path):
    packet = fixture_packet(tmp_path, attested=False)
    decision = approved_fixture_decision(packet)
    report = validate_decision(packet, decision, require_complete=True)
    assert report["production_approved"] is True

    out = tmp_path / "reviewed"
    attestations = pending_attestation_fixture(tmp_path, packet)
    manifest = prepare_reviewed_bundle(
        packet=packet,
        decision=decision,
        rights_path=CONFIG / "data_rights.json",
        evidence_path=CONFIG / "data_rights_evidence.json",
        source_lock_path=CONFIG / "corpus_sources.lock.json",
        git_source_lock_path=CONFIG / "git_sources.lock.json",
        first_party_attestation_paths=attestations,
        first_party_root=tmp_path / "workspace",
        out_dir=out,
    )
    assert manifest["production_approved"] is True
    assert (out / "data_rights.json").is_file()
    assert (out / "data_rights_evidence.json").is_file()
    assert (out / "first_party_tools_protocol.attestation.json").is_file()
    assert (out / "first_party_trajectories.attestation.json").is_file()
    assert (out / "reviewed-rights-bundle.manifest.json").is_file()
    assert all(
        record["ownership_attested"]
        for record in manifest["first_party_attestations"].values()
    )
