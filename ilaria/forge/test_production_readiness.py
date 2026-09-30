from __future__ import annotations

from production_readiness import assess_rights


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
