from __future__ import annotations

import json
from pathlib import Path

import production_readiness
from production_readiness import assess_rights, assess_trajectory_quality
from workspace_paths import benchmark_root


ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(__file__).resolve().parent / "config"
QUALITY = benchmark_root(ROOT) / "imc_125m_trajectory_quality" / "RESULTS.json"


def test_rights_readiness_reports_review_required_sources():
    registry = {
        "sources": {
            "a": {
                "status": "REVIEW_REQUIRED",
                "commercial_use_approved": False,
                "review_ref": "",
            }
        }
    }
    evidence = {
        "sources": {
            "a": {
                "review_state": "EVIDENCE_COLLECTED",
                "unresolved_obligations": ["manual review"],
            }
        }
    }
    report = assess_rights(registry, evidence)
    assert report["ready"] is False
    assert report["approved_sources"] == []
    assert report["blockers"] == ["rights:a:status=REVIEW_REQUIRED"]


def test_rights_readiness_accepts_closed_approval():
    registry = {
        "sources": {
            "a": {
                "status": "APPROVED",
                "commercial_use_approved": True,
                "review_ref": "legal-review-1",
            }
        }
    }
    evidence = {
        "sources": {
            "a": {
                "review_state": "APPROVED",
                "unresolved_obligations": [],
            }
        }
    }
    report = assess_rights(registry, evidence)
    assert report["ready"] is True
    assert report["approved_sources"] == ["a"]
    assert report["blockers"] == []


def test_rights_readiness_reports_missing_required_registry_source():
    report = assess_rights(
        {"sources": {}},
        {"sources": {}},
        required_sources=["unknown"],
    )
    assert report["ready"] is False
    assert report["approved_sources"] == []
    assert report["blockers"] == ["rights:unknown:missing_registry_source"]


def test_first_party_attestation_reports_io_failure(tmp_path, monkeypatch):
    attestation = tmp_path / "attestation.json"
    attestation.write_text("{}", encoding="utf-8")

    def fail_validation(*args, **kwargs):
        raise OSError("read failed")

    monkeypatch.setattr(production_readiness, "validate_attestation", fail_validation)
    report = production_readiness.assess_first_party_attestation(
        attestation,
        workspace_root=tmp_path,
    )
    assert report["valid"] is False
    assert report["error"] == "read failed"


def test_canonical_trajectory_quality_recomputes_exactly():
    report = assess_trajectory_quality(
        QUALITY,
        generation_config_path=CONFIG / "imc_125m_trajectory_generation.json",
    )
    assert report["valid"] is True
    assert len(report["quality_gate_sha256"]) == 64


def test_trajectory_quality_rejects_report_drift(tmp_path):
    value = json.loads(QUALITY.read_text(encoding="utf-8"))
    value["lanes"]["world_device_trajectories"]["mean_text_bytes"] += 1
    path = tmp_path / "quality.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    report = assess_trajectory_quality(
        path,
        generation_config_path=CONFIG / "imc_125m_trajectory_generation.json",
    )
    assert report["valid"] is False
    assert "differs from canonical recomputation" in report["error"]
