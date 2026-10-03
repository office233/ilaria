"""Explicit human-review decisions for the IMC-125M production data gate.

The workflow is intentionally two-phase:
1. create and review a content-addressed decision file;
2. materialize reviewed registry/attestation files into a separate output bundle.

This module never edits canonical config files in-place. Production installation
is a separate explicit operation after the reviewed bundle has been inspected.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from data_contract import (
    atomic_write_json,
    canonical_json_sha256,
    load_rights_registry,
    require_approved_rights,
    require_lower_sha256,
    sha256_file,
)
from first_party_attestation import (
    inspect_attestation,
    validate_attestation,
)
from production_review_packet import PACKET_FORMAT
from rights_evidence import load_and_validate_evidence, require_approved_evidence


DECISION_FORMAT = "imc-125m-production-review-decision-v1"
BUNDLE_FORMAT = "imc-125m-reviewed-rights-bundle-v1"
_EXTERNAL_DECISIONS = frozenset({"PENDING", "APPROVE", "REJECT"})
_FIRST_PARTY_DECISIONS = frozenset({"PENDING", "ATTEST", "REJECT"})


def _identity_hash(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def load_review_packet(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        packet = json.load(stream)
    if not isinstance(packet, dict) or packet.get("format") != PACKET_FORMAT:
        raise ValueError("unsupported production review packet format")
    declared = packet.get("review_packet_sha256", "")
    require_lower_sha256("review_packet_sha256", declared)
    if _identity_hash(packet, "review_packet_sha256") != declared:
        raise ValueError("production review packet identity hash mismatch")
    external = packet.get("external_sources")
    first_party = packet.get("first_party_sources")
    if not isinstance(external, dict) or not external:
        raise ValueError("production review packet has no external sources")
    if not isinstance(first_party, dict) or not first_party:
        raise ValueError("production review packet has no first-party sources")
    return packet


def build_decision_template(packet: dict) -> dict:
    decision = {
        "format": DECISION_FORMAT,
        "review_packet_sha256": packet["review_packet_sha256"],
        "external_sources": {
            source: {
                "decision": "PENDING",
                "reviewed_by": "",
                "review_ref": "",
                "resolved_obligations": [],
            }
            for source in sorted(packet["external_sources"])
        },
        "first_party_sources": {
            source: {
                "decision": "PENDING",
                "attested_by": "",
                "review_ref": "",
            }
            for source in sorted(packet["first_party_sources"])
        },
    }
    decision["decision_sha256"] = _identity_hash(decision, "decision_sha256")
    return decision


def load_decision(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        decision = json.load(stream)
    if not isinstance(decision, dict) or decision.get("format") != DECISION_FORMAT:
        raise ValueError("unsupported production review decision format")
    declared = decision.get("decision_sha256", "")
    require_lower_sha256("decision_sha256", declared)
    if _identity_hash(decision, "decision_sha256") != declared:
        raise ValueError("production review decision identity hash mismatch")
    return decision


def validate_decision(
    packet: dict,
    decision: dict,
    *,
    require_complete: bool = False,
) -> dict:
    if decision.get("review_packet_sha256") != packet.get("review_packet_sha256"):
        raise ValueError("review decision points at a different review packet")

    external = decision.get("external_sources")
    first_party = decision.get("first_party_sources")
    if not isinstance(external, dict) or set(external) != set(packet["external_sources"]):
        raise ValueError("review decision external source set mismatch")
    if not isinstance(first_party, dict) or set(first_party) != set(
        packet["first_party_sources"]
    ):
        raise ValueError("review decision first-party source set mismatch")

    pending_external: list[str] = []
    rejected_external: list[str] = []
    for source, record in sorted(external.items()):
        if not isinstance(record, dict):
            raise ValueError(f"review decision external record {source!r} is invalid")
        state = record.get("decision")
        if state not in _EXTERNAL_DECISIONS:
            raise ValueError(f"review decision state is invalid for {source!r}")
        resolved = record.get("resolved_obligations")
        if not isinstance(resolved, list) or not all(
            isinstance(item, str) and item for item in resolved
        ):
            raise ValueError(f"resolved obligations are invalid for {source!r}")
        expected_obligations = list(
            packet["external_sources"][source].get("unresolved_obligations", [])
        )
        if state == "PENDING":
            pending_external.append(source)
            continue
        actor = record.get("reviewed_by")
        review_ref = record.get("review_ref")
        if not isinstance(actor, str) or not actor.strip():
            raise ValueError(f"review decision has no reviewed_by for {source!r}")
        if not isinstance(review_ref, str) or not review_ref.strip():
            raise ValueError(f"review decision has no review_ref for {source!r}")
        if state == "APPROVE":
            if resolved != expected_obligations:
                raise ValueError(
                    f"approved source {source!r} must explicitly resolve every "
                    "packet obligation in original order"
                )
        else:
            rejected_external.append(source)

    pending_first_party: list[str] = []
    rejected_first_party: list[str] = []
    for source, record in sorted(first_party.items()):
        if not isinstance(record, dict):
            raise ValueError(f"review decision first-party record {source!r} is invalid")
        state = record.get("decision")
        if state not in _FIRST_PARTY_DECISIONS:
            raise ValueError(f"first-party review decision is invalid for {source!r}")
        if state == "PENDING":
            pending_first_party.append(source)
            continue
        actor = record.get("attested_by")
        review_ref = record.get("review_ref")
        if not isinstance(actor, str) or not actor.strip():
            raise ValueError(f"first-party review has no attested_by for {source!r}")
        if not isinstance(review_ref, str) or not review_ref.strip():
            raise ValueError(f"first-party review has no review_ref for {source!r}")
        if state == "REJECT":
            rejected_first_party.append(source)

    if require_complete and (pending_external or pending_first_party):
        raise ValueError(
            "production review decision is incomplete: external_pending="
            + ",".join(pending_external)
            + "; first_party_pending="
            + ",".join(pending_first_party)
        )
    return {
        "complete": not pending_external and not pending_first_party,
        "production_approved": (
            not pending_external
            and not pending_first_party
            and not rejected_external
            and not rejected_first_party
        ),
        "external_pending": pending_external,
        "external_rejected": rejected_external,
        "first_party_pending": pending_first_party,
        "first_party_rejected": rejected_first_party,
        "decision_sha256": decision["decision_sha256"],
        "review_packet_sha256": packet["review_packet_sha256"],
    }


def _write_reviewed_attestation(
    source: str,
    *,
    packet: dict,
    decision: dict,
    input_path: str | Path,
    workspace_root: str | Path,
    output_path: str | Path,
) -> dict:
    current = inspect_attestation(input_path, workspace_root=workspace_root)
    packet_record = packet["first_party_sources"][source]
    if current["attestation_sha256"] != packet_record["attestation_sha256"]:
        raise ValueError(f"first-party attestation drifted since review packet: {source}")
    value = copy.deepcopy(current)
    record = decision["first_party_sources"][source]
    state = record["decision"]
    value["ownership_attested"] = state == "ATTEST"
    value["attested_by"] = record["attested_by"]
    value["review_ref"] = record["review_ref"]
    value["attestation_sha256"] = _identity_hash(value, "attestation_sha256")
    atomic_write_json(output_path, value)
    if state == "ATTEST":
        validate_attestation(output_path, workspace_root=workspace_root)
    else:
        inspect_attestation(output_path, workspace_root=workspace_root)
    return value


def prepare_reviewed_bundle(
    *,
    packet: dict,
    decision: dict,
    rights_path: str | Path,
    evidence_path: str | Path,
    source_lock_path: str | Path,
    git_source_lock_path: str | Path,
    first_party_attestation_paths: dict[str, str | Path],
    first_party_root: str | Path,
    out_dir: str | Path,
) -> dict:
    decision_report = validate_decision(packet, decision, require_complete=True)
    if set(first_party_attestation_paths) != set(packet["first_party_sources"]):
        raise ValueError("review bundle first-party attestation set mismatch")

    rights = copy.deepcopy(load_rights_registry(rights_path))
    evidence = copy.deepcopy(
        load_and_validate_evidence(
            evidence_path,
            source_lock_path=source_lock_path,
            rights_registry_path=rights_path,
            git_source_lock_path=git_source_lock_path,
        )
    )

    for source, review in decision["external_sources"].items():
        registry_record = rights["sources"][source]
        evidence_record = evidence["sources"][source]
        state = review["decision"]
        registry_record["review_ref"] = review["review_ref"]
        if state == "APPROVE":
            registry_record["status"] = "APPROVED"
            registry_record["commercial_use_approved"] = True
            evidence_record["review_state"] = "APPROVED"
            evidence_record["unresolved_obligations"] = []
        else:
            registry_record["status"] = "REJECTED"
            registry_record["commercial_use_approved"] = False
            evidence_record["review_state"] = "REJECTED"

    evidence["evidence_sha256"] = _identity_hash(evidence, "evidence_sha256")
    rights_evidence = rights.get("evidence")
    if not isinstance(rights_evidence, dict):
        raise ValueError("rights registry has no evidence identity")
    rights_evidence["sha256"] = evidence["evidence_sha256"]

    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    reviewed_evidence_path = output / Path(evidence_path).name
    reviewed_rights_path = output / Path(rights_path).name
    atomic_write_json(reviewed_evidence_path, evidence)
    atomic_write_json(reviewed_rights_path, rights)

    validated_evidence = load_and_validate_evidence(
        reviewed_evidence_path,
        source_lock_path=source_lock_path,
        rights_registry_path=reviewed_rights_path,
        git_source_lock_path=git_source_lock_path,
    )
    approved_external = sorted(
        source
        for source, review in decision["external_sources"].items()
        if review["decision"] == "APPROVE"
    )
    require_approved_rights(rights, approved_external)
    require_approved_evidence(rights, validated_evidence, approved_external)

    first_party_outputs: dict[str, dict] = {}
    for source, input_path in sorted(first_party_attestation_paths.items()):
        destination = output / Path(input_path).name
        value = _write_reviewed_attestation(
            source,
            packet=packet,
            decision=decision,
            input_path=input_path,
            workspace_root=first_party_root,
            output_path=destination,
        )
        first_party_outputs[source] = {
            "filename": destination.name,
            "sha256": sha256_file(destination),
            "attestation_sha256": value["attestation_sha256"],
            "ownership_attested": value["ownership_attested"],
        }

    manifest = {
        "format": BUNDLE_FORMAT,
        "review_packet_sha256": packet["review_packet_sha256"],
        "decision_sha256": decision["decision_sha256"],
        "production_approved": decision_report["production_approved"],
        "rights": {
            "filename": reviewed_rights_path.name,
            "sha256": sha256_file(reviewed_rights_path),
        },
        "evidence": {
            "filename": reviewed_evidence_path.name,
            "sha256": sha256_file(reviewed_evidence_path),
            "evidence_sha256": validated_evidence["evidence_sha256"],
        },
        "first_party_attestations": first_party_outputs,
        "rejections": {
            "external": decision_report["external_rejected"],
            "first_party": decision_report["first_party_rejected"],
        },
    }
    manifest["bundle_sha256"] = _identity_hash(manifest, "bundle_sha256")
    atomic_write_json(output / "reviewed-rights-bundle.manifest.json", manifest)
    return manifest


def rehash_decision(decision: dict) -> dict:
    decision = copy.deepcopy(decision)
    decision["decision_sha256"] = _identity_hash(decision, "decision_sha256")
    return decision


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    template = sub.add_parser("template")
    template.add_argument("--packet", required=True)
    template.add_argument("--out", required=True)

    validate = sub.add_parser("validate")
    validate.add_argument("--packet", required=True)
    validate.add_argument("--decision", required=True)
    validate.add_argument("--require-complete", action="store_true")

    prepare = sub.add_parser("prepare")
    prepare.add_argument("--packet", required=True)
    prepare.add_argument("--decision", required=True)
    prepare.add_argument("--rights", required=True)
    prepare.add_argument("--evidence", required=True)
    prepare.add_argument("--source-lock", required=True)
    prepare.add_argument("--git-source-lock", required=True)
    prepare.add_argument("--first-party-contracts", required=True)
    prepare.add_argument("--first-party-math", default="")
    prepare.add_argument("--first-party-trajectories", required=True)
    prepare.add_argument("--first-party-root", required=True)
    prepare.add_argument("--out-dir", required=True)

    rehash = sub.add_parser("rehash")
    rehash.add_argument("--decision", required=True)
    rehash.add_argument("--out", required=True)

    args = parser.parse_args()
    if args.command == "template":
        packet = load_review_packet(args.packet)
        decision = build_decision_template(packet)
        atomic_write_json(args.out, decision)
        print(f"[review-decision] pending template: {decision['decision_sha256']}")
        return
    if args.command == "rehash":
        with Path(args.decision).open(encoding="utf-8") as stream:
            decision = json.load(stream)
        if decision.get("format") != DECISION_FORMAT:
            raise ValueError("unsupported production review decision format")
        decision = rehash_decision(decision)
        atomic_write_json(args.out, decision)
        print(f"[review-decision] rehashed: {decision['decision_sha256']}")
        return

    packet = load_review_packet(args.packet)
    decision = load_decision(args.decision)
    if args.command == "validate":
        report = validate_decision(
            packet,
            decision,
            require_complete=args.require_complete,
        )
        print(json.dumps(report, indent=2, sort_keys=True))
        return

    first_party_paths = {
        "first_party_contracts": args.first_party_contracts,
        "first_party_trajectories": args.first_party_trajectories,
    }
    if "first_party_math" in packet["first_party_sources"]:
        if not args.first_party_math:
            raise ValueError("review packet requires --first-party-math")
        first_party_paths["first_party_math"] = args.first_party_math
    elif args.first_party_math:
        raise ValueError("--first-party-math was supplied but is not present in the review packet")

    manifest = prepare_reviewed_bundle(
        packet=packet,
        decision=decision,
        rights_path=args.rights,
        evidence_path=args.evidence,
        source_lock_path=args.source_lock,
        git_source_lock_path=args.git_source_lock,
        first_party_attestation_paths=first_party_paths,
        first_party_root=args.first_party_root,
        out_dir=args.out_dir,
    )
    print(
        f"[review-decision] reviewed bundle: {manifest['bundle_sha256']} "
        f"production_approved={manifest['production_approved']}"
    )


if __name__ == "__main__":
    main()
