"""Validate and apply explicit human rights-review decisions without self-approval."""
from __future__ import annotations

import argparse
import copy
import json
import re
from pathlib import Path

try:
    from .data_contract import atomic_write_json, canonical_json_sha256, load_rights_registry
    from .rights_evidence import load_and_validate_evidence
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, canonical_json_sha256, load_rights_registry
    from rights_evidence import load_and_validate_evidence

DECISION_FORMAT = "ilaria-rights-review-decision-v1"
_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _decision_hash(packet: dict) -> str:
    payload = dict(packet)
    payload.pop("decision_sha256", None)
    return canonical_json_sha256(payload)


def validate_decision_packet(
    packet: dict,
    *,
    rights: dict,
    evidence: dict,
) -> dict:
    if not isinstance(packet, dict) or packet.get("format") != DECISION_FORMAT:
        raise ValueError("unsupported rights review decision format")
    declared = packet.get("decision_sha256")
    if not isinstance(declared, str) or _decision_hash(packet) != declared:
        raise ValueError("rights review decision identity hash mismatch")
    if packet.get("evidence_sha256") != evidence.get("evidence_sha256"):
        raise ValueError("rights review decision evidence hash mismatch")
    if packet.get("source_lock_sha256") != evidence.get("source_lock_sha256"):
        raise ValueError("rights review decision source lock hash mismatch")
    if packet.get("git_source_lock_sha256") != evidence.get("git_source_lock_sha256"):
        raise ValueError("rights review decision git source lock hash mismatch")
    if not str(packet.get("reviewer", "")).strip():
        raise ValueError("rights review decision requires a reviewer")
    reviewed_at = packet.get("reviewed_at")
    if not isinstance(reviewed_at, str) or not _UTC.fullmatch(reviewed_at):
        raise ValueError("rights review decision reviewed_at must be UTC YYYY-MM-DDTHH:MM:SSZ")
    decisions = packet.get("decisions")
    if not isinstance(decisions, dict) or not decisions:
        raise ValueError("rights review decision has no source decisions")
    unknown = sorted(set(decisions) - set(rights["sources"]))
    if unknown:
        raise ValueError(f"rights review decision contains unknown sources: {unknown}")

    for name in sorted(decisions):
        decision = decisions[name]
        if not isinstance(decision, dict):
            raise ValueError(f"rights review decision for {name!r} is invalid")
        outcome = decision.get("decision")
        if outcome not in {"APPROVED", "REJECTED"}:
            raise ValueError(f"rights review decision for {name!r} has invalid outcome")
        review_ref = str(decision.get("review_ref", "")).strip()
        if not review_ref:
            raise ValueError(f"rights review decision for {name!r} has no review_ref")
        if not str(decision.get("notes", "")).strip():
            raise ValueError(f"rights review decision for {name!r} has no notes")
        resolved = decision.get("resolved_obligations")
        if not isinstance(resolved, list) or not all(
            isinstance(item, str) and item.strip() for item in resolved
        ):
            raise ValueError(
                f"rights review decision for {name!r} has invalid resolved_obligations"
            )
        evidence_record = evidence["sources"][name]
        existing = evidence_record.get("unresolved_obligations")
        if not isinstance(existing, list):
            raise ValueError(f"rights evidence obligations are invalid for {name!r}")
        if outcome == "APPROVED":
            if decision.get("commercial_use_approved") is not True:
                raise ValueError(
                    f"approved source {name!r} must explicitly approve commercial use"
                )
            if sorted(resolved) != sorted(existing):
                raise ValueError(
                    f"approved source {name!r} must resolve every pinned obligation"
                )
        elif decision.get("commercial_use_approved") is not False:
            raise ValueError(
                f"rejected source {name!r} must set commercial_use_approved=false"
            )
    return packet


def apply_decision_packet(packet: dict, *, rights: dict, evidence: dict) -> tuple[dict, dict]:
    validate_decision_packet(packet, rights=rights, evidence=evidence)
    new_rights = copy.deepcopy(rights)
    new_evidence = copy.deepcopy(evidence)
    for name, decision in packet["decisions"].items():
        outcome = decision["decision"]
        registry_record = new_rights["sources"][name]
        evidence_record = new_evidence["sources"][name]
        registry_record["status"] = outcome
        registry_record["commercial_use_approved"] = decision["commercial_use_approved"]
        registry_record["review_ref"] = decision["review_ref"]
        registry_record["note"] = decision["notes"]
        evidence_record["review_state"] = outcome
        if outcome == "APPROVED":
            evidence_record["unresolved_obligations"] = []
        else:
            evidence_record["unresolved_obligations"] = list(
                evidence_record.get("unresolved_obligations", [])
            )
    new_evidence.pop("evidence_sha256", None)
    new_evidence["evidence_sha256"] = canonical_json_sha256(new_evidence)
    new_rights["evidence"]["sha256"] = new_evidence["evidence_sha256"]
    return new_rights, new_evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--decision", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--source-lock", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--out-rights", required=True)
    parser.add_argument("--out-evidence", required=True)
    args = parser.parse_args()
    with Path(args.decision).open(encoding="utf-8") as stream:
        packet = json.load(stream)
    rights = load_rights_registry(args.rights)
    evidence = load_and_validate_evidence(
        args.evidence,
        source_lock_path=args.source_lock,
        rights_registry_path=args.rights,
    )
    new_rights, new_evidence = apply_decision_packet(
        packet, rights=rights, evidence=evidence
    )
    atomic_write_json(args.out_evidence, new_evidence)
    atomic_write_json(args.out_rights, new_rights)
    print(
        f"[rights-review] applied {len(packet['decisions'])} decision(s); "
        f"evidence={new_evidence['evidence_sha256']}"
    )


if __name__ == "__main__":
    main()
