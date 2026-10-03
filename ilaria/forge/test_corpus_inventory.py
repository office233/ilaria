from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from corpus_inventory import (
    INVENTORY_FORMAT,
    build_inventory,
    classify_path,
    load_lane_rules,
)
from curriculum_stream import REQUIRED_LANES
from data_contract import canonical_json_sha256
from first_party_attestation import attestation_scope_sha256, build_attestation_template


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_curriculum(path: Path) -> None:
    mix = {lane: 0 for lane in REQUIRED_LANES}
    mix["code"] = 500_000
    mix["os_hardware_drivers_standards"] = 500_000
    path.write_text(
        json.dumps(
            {
                "format": "imc-125m-curriculum-v1",
                "policy": "exact-token-budget-v1",
                "boundary_policy": "replace-final-lane-token-with-eos-v1",
                "target_mix_ppm": mix,
            }
        ),
        encoding="utf-8",
    )


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "format": "imc-125m-inventory-lanes-v1",
                "sources": {
                    "alpha": {
                        "rules": [
                            {
                                "lane": "os_hardware_drivers_standards",
                                "path_globs": ["drivers/**"],
                            },
                            {"lane": "code", "default": True},
                        ]
                    },
                    "beta": {
                        "rules": [{"lane": "code", "default": True}]
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def _write_rights(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "policy": "fixture",
                "sources": {
                    "alpha": {
                        "status": "APPROVED",
                        "commercial_use_approved": True,
                        "review_ref": "TEST-1",
                    },
                    "beta": {
                        "status": "REVIEW_REQUIRED",
                        "commercial_use_approved": False,
                        "review_ref": "",
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def _write_source(root: Path, name: str, revision: str, rows: list[dict]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    shard = root / f"{name}-00000.jsonl"
    shard.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    manifest = root / f"{name}.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "docs": len(rows),
                "source": {
                    "name": name,
                    "revision": revision,
                    "provider": "fixture",
                    "language": "code",
                    "config": None,
                },
                "shard_records": [
                    {
                        "index": 0,
                        "filename": shard.name,
                        "sha256": _sha(shard),
                        "bytes": shard.stat().st_size,
                        "documents": len(rows),
                    }
                ],
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return manifest


def test_classification_is_exclusive_and_defaulted(tmp_path):
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    rules = load_lane_rules(rules_path, set(REQUIRED_LANES))

    assert (
        classify_path("alpha", "drivers/uart.c", rules)
        == "os_hardware_drivers_standards"
    )
    assert classify_path("alpha", "lib/parser.c", rules) == "code"


def test_inventory_deduplicates_globally_and_keeps_rights_separate(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    rules = tmp_path / "rules.json"
    rights = tmp_path / "rights.json"
    _write_curriculum(curriculum)
    _write_rules(rules)
    _write_rights(rights)

    alpha = _write_source(
        tmp_path / "alpha",
        "alpha",
        "a1",
        [
            {"path": "drivers/a.c", "text": "Driver Alpha"},
            {"path": "lib/a.c", "text": "Shared Document"},
        ],
    )
    beta = _write_source(
        tmp_path / "beta",
        "beta",
        "b1",
        [
            {"path": "src/b.c", "text": "shared   document"},
            {"path": "src/c.c", "text": "Unique Beta"},
        ],
    )

    report = build_inventory(
        [beta, alpha],
        curriculum_path=curriculum,
        lane_rules_path=rules,
        rights_registry_path=rights,
        target_tokens=1000,
    )

    assert report["format"] == INVENTORY_FORMAT
    assert report["totals"]["raw_documents"] == 4
    assert report["totals"]["documents"] == 3
    assert report["totals"]["duplicates_removed"] == 1
    assert report["sources"]["alpha"]["rights_status"] == "APPROVED"
    assert report["sources"]["beta"]["rights_status"] == "REVIEW_REQUIRED"
    assert (
        report["lanes"]["os_hardware_drivers_standards"]["approved"]["documents"]
        == 1
    )
    assert report["lanes"]["code"]["approved"]["documents"] == 1
    assert report["lanes"]["code"]["candidate"]["documents"] == 2
    assert report["counting"]["mode"] == "estimated"


def test_inventory_is_input_order_deterministic(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    rules = tmp_path / "rules.json"
    rights = tmp_path / "rights.json"
    _write_curriculum(curriculum)
    _write_rules(rules)
    _write_rights(rights)
    alpha = _write_source(
        tmp_path / "alpha",
        "alpha",
        "a1",
        [{"path": "lib/a.c", "text": "same"}],
    )
    beta = _write_source(
        tmp_path / "beta",
        "beta",
        "b1",
        [{"path": "src/b.c", "text": "SAME"}],
    )

    first = build_inventory(
        [alpha, beta],
        curriculum_path=curriculum,
        lane_rules_path=rules,
        rights_registry_path=rights,
        target_tokens=100,
    )
    second = build_inventory(
        [beta, alpha],
        curriculum_path=curriculum,
        lane_rules_path=rules,
        rights_registry_path=rights,
        target_tokens=100,
    )
    assert first == second


def test_manifest_hash_drift_fails_closed(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    rules = tmp_path / "rules.json"
    rights = tmp_path / "rights.json"
    _write_curriculum(curriculum)
    _write_rules(rules)
    _write_rights(rights)
    manifest = _write_source(
        tmp_path / "alpha",
        "alpha",
        "a1",
        [{"path": "lib/a.c", "text": "one"}],
    )
    shard = manifest.parent / "alpha-00000.jsonl"
    shard.write_text(
        shard.read_text(encoding="utf-8") + json.dumps({"path": "x", "text": "tamper"}) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="size mismatch|SHA-256 mismatch"):
        build_inventory(
            [manifest],
            curriculum_path=curriculum,
            lane_rules_path=rules,
            rights_registry_path=rights,
            target_tokens=100,
        )


def test_inventory_rejects_shard_path_escape(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    rules = tmp_path / "rules.json"
    rights = tmp_path / "rights.json"
    _write_curriculum(curriculum)
    _write_rules(rules)
    _write_rights(rights)
    manifest = _write_source(
        tmp_path / "alpha",
        "alpha",
        "a1",
        [{"path": "lib/a.c", "text": "one"}],
    )
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["shard_records"][0]["filename"] = "../outside.jsonl"
    outside = manifest.parent.parent / "outside.jsonl"
    outside.write_text('{"path":"lib/a.c","text":"one"}\n', encoding="utf-8")
    raw["shard_records"][0]["bytes"] = outside.stat().st_size
    raw["shard_records"][0]["sha256"] = _sha(outside)
    manifest.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(ValueError, match="escapes manifest directory"):
        build_inventory(
            [manifest],
            curriculum_path=curriculum,
            lane_rules_path=rules,
            rights_registry_path=rights,
            target_tokens=100,
        )


@pytest.mark.parametrize("bad_index", [None, -1, "0"])
def test_inventory_rejects_invalid_shard_index(tmp_path, bad_index):
    manifest = _write_source(
        tmp_path / "alpha",
        "alpha",
        "a1",
        [{"path": "lib/a.c", "text": "one"}],
    )
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["shard_records"][0]["index"] = bad_index
    manifest.write_text(json.dumps(raw), encoding="utf-8")

    curriculum = tmp_path / "curriculum.json"
    rules = tmp_path / "rules.json"
    rights = tmp_path / "rights.json"
    _write_curriculum(curriculum)
    _write_rules(rules)
    _write_rights(rights)
    with pytest.raises(ValueError, match="invalid shard index"):
        build_inventory(
            [manifest],
            curriculum_path=curriculum,
            lane_rules_path=rules,
            rights_registry_path=rights,
            target_tokens=100,
        )


def test_lane_rules_reject_ambiguous_patterns(tmp_path):
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    raw = json.loads(rules_path.read_text(encoding="utf-8"))
    raw["sources"]["alpha"]["rules"].insert(
        1,
        {"lane": "code", "path_globs": ["drivers/**"]},
    )
    rules_path.write_text(json.dumps(raw), encoding="utf-8")
    rules = load_lane_rules(rules_path, set(REQUIRED_LANES))
    with pytest.raises(ValueError, match="ambiguous lane classification"):
        classify_path("alpha", "drivers/x.c", rules)


def test_unsigned_first_party_source_is_candidate_only(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    mix = {lane: 0 for lane in REQUIRED_LANES}
    mix["agent_tool_trajectories"] = 1_000_000
    curriculum.write_text(
        json.dumps(
            {
                "format": "imc-125m-curriculum-v1",
                "policy": "exact-token-budget-v1",
                "boundary_policy": "replace-final-lane-token-with-eos-v1",
                "target_mix_ppm": mix,
            }
        ),
        encoding="utf-8",
    )
    rules = tmp_path / "rules.json"
    rules.write_text(
        json.dumps(
            {
                "format": "imc-125m-inventory-lanes-v1",
                "sources": {
                    "first_party": {
                        "rules": [
                            {
                                "lane": "agent_tool_trajectories",
                                "default": True,
                            }
                        ]
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    rights = tmp_path / "rights.json"
    rights.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "policy": "fixture",
                "sources": {
                    "unrelated_external": {
                        "status": "REVIEW_REQUIRED",
                        "commercial_use_approved": False,
                        "review_ref": "",
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    owned = tmp_path / "owned-generator.py"
    owned.write_text("# first-party generator fixture\n", encoding="utf-8")
    attestation_data = build_attestation_template(
        tmp_path, paths=[owned.name]
    )
    attestation = tmp_path / "attestation.json"
    attestation.write_text(json.dumps(attestation_data), encoding="utf-8")

    manifest = _write_source(
        tmp_path / "candidate",
        "first_party",
        "r1",
        [
            {
                "path": "agent_tool_trajectories/00000/task-1",
                "text": "verified synthetic trajectory",
            }
        ],
    )
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["pipeline"] = {
        "rights_basis": "first_party_attestation",
        "attestation_scope_sha256": attestation_scope_sha256(attestation_data),
        "attestation_required_files": list(attestation_data["files"]),
    }
    manifest.write_text(json.dumps(raw, sort_keys=True), encoding="utf-8")

    report = build_inventory(
        [manifest],
        curriculum_path=curriculum,
        lane_rules_path=rules,
        rights_registry_path=rights,
        target_tokens=100,
        first_party_attestations={"first_party": attestation},
        first_party_root=tmp_path,
    )
    source = report["sources"]["first_party"]
    assert source["rights_status"] == "OWNERSHIP_ATTESTATION_REQUIRED"
    assert source["eligibility_basis"] == "first_party_attestation"
    assert source["stats"]["documents"] == 1
    lane = report["lanes"]["agent_tool_trajectories"]
    assert lane["candidate"]["documents"] == 1
    assert lane["approved"]["documents"] == 0


def test_signed_first_party_source_becomes_approved(tmp_path):
    curriculum = tmp_path / "curriculum.json"
    mix = {lane: 0 for lane in REQUIRED_LANES}
    mix["agent_tool_trajectories"] = 1_000_000
    curriculum.write_text(
        json.dumps(
            {
                "format": "imc-125m-curriculum-v1",
                "policy": "exact-token-budget-v1",
                "boundary_policy": "replace-final-lane-token-with-eos-v1",
                "target_mix_ppm": mix,
            }
        ),
        encoding="utf-8",
    )
    rules = tmp_path / "rules.json"
    rules.write_text(
        json.dumps(
            {
                "format": "imc-125m-inventory-lanes-v1",
                "sources": {
                    "first_party": {
                        "rules": [
                            {
                                "lane": "agent_tool_trajectories",
                                "default": True,
                            }
                        ]
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    rights = tmp_path / "rights.json"
    rights.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "policy": "fixture",
                "sources": {
                    "unrelated_external": {
                        "status": "REVIEW_REQUIRED",
                        "commercial_use_approved": False,
                        "review_ref": "",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    owned = tmp_path / "owned-generator.py"
    owned.write_text("# first-party generator fixture\n", encoding="utf-8")
    attestation_data = build_attestation_template(tmp_path, paths=[owned.name])
    attestation_data.update(
        {
            "ownership_attested": True,
            "attested_by": "fixture-owner",
            "review_ref": "fixture-review-1",
        }
    )
    identity_payload = dict(attestation_data)
    identity_payload.pop("attestation_sha256", None)
    attestation_data["attestation_sha256"] = canonical_json_sha256(
        identity_payload
    )
    attestation = tmp_path / "attestation.json"
    attestation.write_text(json.dumps(attestation_data), encoding="utf-8")
    manifest = _write_source(
        tmp_path / "candidate",
        "first_party",
        "r1",
        [
            {
                "path": "agent_tool_trajectories/00000/task-1",
                "text": "verified signed first-party trajectory",
            }
        ],
    )
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["pipeline"] = {
        "rights_basis": "first_party_attestation",
        "attestation_scope_sha256": attestation_scope_sha256(attestation_data),
        "attestation_required_files": list(attestation_data["files"]),
    }
    manifest.write_text(json.dumps(raw, sort_keys=True), encoding="utf-8")
    report = build_inventory(
        [manifest],
        curriculum_path=curriculum,
        lane_rules_path=rules,
        rights_registry_path=rights,
        target_tokens=100,
        first_party_attestations={"first_party": attestation},
        first_party_root=tmp_path,
    )
    assert report["sources"]["first_party"]["rights_status"] == "ATTESTED_FIRST_PARTY"
    assert report["lanes"]["agent_tool_trajectories"]["approved"]["documents"] == 1
