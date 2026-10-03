from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_contract import atomic_write_json, canonical_json_sha256
from first_party_attestation import build_attestation_template
from workspace_paths import benchmark_root

from production_review_packet import (
    PACKET_FORMAT,
    build_review_packet,
    render_markdown,
)


ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(__file__).resolve().parent / "config"
PLAN = CONFIG / "imc_125m_production_sources.json"
INVENTORY = benchmark_root(ROOT) / "imc_125m_data_inventory" / "candidate-inventory.json"
RIGHTS = CONFIG / "data_rights.json"
EVIDENCE = CONFIG / "data_rights_evidence.json"
HF_LOCK = CONFIG / "corpus_sources.lock.json"
GIT_LOCK = CONFIG / "git_sources.lock.json"


def fixture_attestations(tmp_path: Path, *, attested: bool = True) -> dict[str, Path]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    paths = {}
    for source, filename in {
        "first_party_contracts": "first_party_tools_protocol.attestation.json",
        "first_party_trajectories": "first_party_trajectories.attestation.json",
    }.items():
        document = workspace / f"{source}.txt"
        document.write_text(f"Synthetic {source} fixture.\n", encoding="utf-8")
        value = build_attestation_template(workspace, paths=[document.name])
        if attested:
            value.update(ownership_attested=True, attested_by="fixture-owner", review_ref="fixture-review")
        payload = dict(value)
        payload.pop("attestation_sha256")
        value["attestation_sha256"] = canonical_json_sha256(payload)
        path = tmp_path / filename
        atomic_write_json(path, value)
        paths[source] = path
    return paths


def canonical_packet(tmp_path: Path, *, attested: bool = True):
    """Keep the locked configuration, using isolated synthetic first-party files."""
    return build_review_packet(
        plan_path=PLAN,
        inventory_path=INVENTORY,
        rights_path=RIGHTS,
        evidence_path=EVIDENCE,
        source_lock_path=HF_LOCK,
        git_source_lock_path=GIT_LOCK,
        first_party_attestations=fixture_attestations(tmp_path, attested=attested),
        first_party_root=tmp_path / "workspace",
    )


def test_canonical_review_packet_reflects_reviewed_state_without_auto_approval(tmp_path):
    packet = canonical_packet(tmp_path)
    assert packet["format"] == PACKET_FORMAT
    assert packet["decision_summary"]["auto_approval_performed"] is False
    assert packet["decision_summary"]["external_pending"] == []
    assert packet["decision_summary"]["first_party_pending"] == []
    assert len(packet["review_packet_sha256"]) == 64


def test_review_packet_binds_exact_source_revisions_and_attestation_scopes(tmp_path):
    packet = canonical_packet(tmp_path)
    assert (
        packet["external_sources"]["apache_nuttx"]["revision"]["commit"]
        == "4295024832a0f70820156d2a7e6e09d68897e91f"
    )
    assert (
        packet["external_sources"]["opencode_reasoning_split0"]["revision"][
            "revision"
        ]
        == "20a1ca19c0d050fe9057fc08339d6b370ec1c67a"
    )
    for record in packet["first_party_sources"].values():
        assert len(record["attestation_sha256"]) == 64
        assert len(record["attestation_scope_sha256"]) == 64
        assert record["files"]


def test_review_packet_rejects_wrong_first_party_set():
    with pytest.raises(ValueError, match="attestation set mismatch"):
        build_review_packet(
            plan_path=PLAN,
            inventory_path=INVENTORY,
            rights_path=RIGHTS,
            evidence_path=EVIDENCE,
            source_lock_path=HF_LOCK,
            git_source_lock_path=GIT_LOCK,
            first_party_attestations={
                "first_party_contracts": CONFIG
                / "first_party_tools_protocol.attestation.json"
            },
            first_party_root=ROOT,
        )


def test_review_markdown_surfaces_current_decision_state(tmp_path):
    markdown = render_markdown(canonical_packet(tmp_path))
    assert "auto" not in markdown.lower() or "approval" in markdown.lower()
    assert "apache_nuttx" in markdown
    assert "first_party_trajectories" in markdown
    assert "Pending decisions" in markdown
    assert "External: none" in markdown
    assert "First-party: none" in markdown
