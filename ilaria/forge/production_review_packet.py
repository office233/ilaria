"""Build a deterministic human-review packet for IMC-125M production data.

This module is read-only with respect to the rights registry and ownership
attestations. It collects the exact source plan, revisions, evidence, unresolved
obligations and first-party file scopes that a human reviewer must approve. It
never converts REVIEW_REQUIRED into APPROVED.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from corpus_source_lock import load_source_lock
from data_contract import (
    atomic_write_json,
    canonical_json_sha256,
    load_rights_registry,
    sha256_file,
)
from first_party_attestation import attestation_scope_sha256, inspect_attestation
from git_source_lock import load_lock as load_git_source_lock
from prepare_corpus import SOURCES
from production_source_plan import assess_plan, load_inventory, load_plan
from rights_evidence import load_and_validate_evidence


PACKET_FORMAT = "imc-125m-production-review-packet-v1"


def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("review_packet_sha256", None)
    return canonical_json_sha256(payload)


def _source_revision(
    source: str,
    *,
    hf_lock: dict,
    git_lock: dict,
    inventory: dict,
) -> dict:
    if source in hf_lock["sources"]:
        return {"kind": "huggingface", **dict(hf_lock["sources"][source])}
    if source in git_lock["sources"]:
        return {"kind": "git", **dict(git_lock["sources"][source])}
    record = inventory.get("sources", {}).get(source, {})
    revision = record.get("revision")
    if isinstance(revision, str) and revision:
        return {"kind": "inventory", "revision": revision}
    raise ValueError(f"review source {source!r} has no pinned revision")


def build_review_packet(
    *,
    plan_path: str | Path,
    inventory_path: str | Path,
    rights_path: str | Path,
    evidence_path: str | Path,
    source_lock_path: str | Path,
    git_source_lock_path: str | Path,
    first_party_attestations: dict[str, str | Path],
    first_party_root: str | Path,
) -> dict:
    plan = load_plan(plan_path)
    inventory = load_inventory(inventory_path)
    plan_report = assess_plan(plan, inventory)
    if not plan_report["ready"]:
        raise ValueError(
            "production source plan is not ready: " + ", ".join(plan_report["blockers"])
        )

    rights = load_rights_registry(rights_path)
    evidence = load_and_validate_evidence(
        evidence_path,
        source_lock_path=source_lock_path,
        rights_registry_path=rights_path,
    )
    hf_lock = load_source_lock(source_lock_path, SOURCES)
    git_lock = load_git_source_lock(git_source_lock_path)

    external: dict[str, dict] = {}
    for source in plan_report["required_external_sources"]:
        registry = rights["sources"].get(source)
        ev = evidence["sources"].get(source)
        if not isinstance(registry, dict):
            raise ValueError(f"review source {source!r} is missing from rights registry")
        if not isinstance(ev, dict):
            raise ValueError(f"review source {source!r} is missing rights evidence")
        lane_contributions = {}
        source_inventory = inventory["sources"].get(source, {})
        for lane, record in sorted(source_inventory.get("lanes", {}).items()):
            lane_contributions[lane] = {
                "documents": int(record.get("documents", 0)),
                "estimated_tokens_min": int(record.get("estimated_tokens_min", 0)),
                "estimated_tokens_max": int(record.get("estimated_tokens_max", 0)),
                "text_bytes": int(record.get("text_bytes", 0)),
            }
        external[source] = {
            "revision": _source_revision(
                source,
                hf_lock=hf_lock,
                git_lock=git_lock,
                inventory=inventory,
            ),
            "declared_license": registry.get("declared_license"),
            "rights_status": registry.get("status"),
            "commercial_use_approved": registry.get("commercial_use_approved") is True,
            "review_ref": registry.get("review_ref", ""),
            "evidence_review_state": ev.get("review_state"),
            "unresolved_obligations": list(ev.get("unresolved_obligations", [])),
            "evidence_urls": list(ev.get("evidence_urls", [])),
            "lane_contributions": lane_contributions,
            "human_decision_required": (
                registry.get("status") != "APPROVED"
                or registry.get("commercial_use_approved") is not True
                or not str(registry.get("review_ref", "")).strip()
                or ev.get("review_state") != "APPROVED"
                or ev.get("unresolved_obligations") != []
            ),
        }

    required_first_party = set(plan_report["required_first_party_sources"])
    supplied_first_party = set(first_party_attestations)
    if supplied_first_party != required_first_party:
        raise ValueError(
            "review first-party attestation set mismatch: "
            f"required={sorted(required_first_party)}, supplied={sorted(supplied_first_party)}"
        )

    first_party: dict[str, dict] = {}
    for source, path in sorted(first_party_attestations.items()):
        attestation = inspect_attestation(path, workspace_root=first_party_root)
        first_party[source] = {
            "filename": Path(path).name,
            "attestation_sha256": attestation["attestation_sha256"],
            "attestation_scope_sha256": attestation_scope_sha256(attestation),
            "ownership_attested": attestation.get("ownership_attested") is True,
            "attested_by": attestation.get("attested_by", ""),
            "review_ref": attestation.get("review_ref", ""),
            "files": [dict(record) for record in attestation["files"]],
            "human_decision_required": (
                attestation.get("ownership_attested") is not True
                or not str(attestation.get("attested_by", "")).strip()
                or not str(attestation.get("review_ref", "")).strip()
            ),
        }

    packet = {
        "format": PACKET_FORMAT,
        "policy": "human-rights-and-ownership-review-required-v1",
        "source_plan_sha256": plan["plan_sha256"],
        "inventory_sha256": inventory["inventory_sha256"],
        "curriculum_sha256": inventory["curriculum"]["identity_sha256"],
        "rights_registry_sha256": sha256_file(rights_path),
        "rights_evidence_sha256": sha256_file(evidence_path),
        "source_lock_file_sha256": sha256_file(source_lock_path),
        "git_source_lock_file_sha256": sha256_file(git_source_lock_path),
        "external_sources": external,
        "first_party_sources": first_party,
        "decision_summary": {
            "external_pending": sorted(
                source
                for source, record in external.items()
                if record["human_decision_required"]
            ),
            "first_party_pending": sorted(
                source
                for source, record in first_party.items()
                if record["human_decision_required"]
            ),
            "auto_approval_performed": False,
        },
    }
    packet["review_packet_sha256"] = _identity_hash(packet)
    return packet


def render_markdown(packet: dict) -> str:
    lines = [
        "# IMC-125M production rights & ownership review",
        "",
        "Review packet: " + packet["review_packet_sha256"],
        "Source plan: " + packet["source_plan_sha256"],
        "Inventory: " + packet["inventory_sha256"],
        "",
        "This packet is evidence for human review only. It performs no rights or ownership approval.",
        "",
        "## External sources",
        "",
        "| Source | License | Status | Evidence | Pending obligations |",
        "|---|---|---|---|---:|",
    ]
    for source, record in sorted(packet["external_sources"].items()):
        lines.append(
            "| "
            + " | ".join(
                [
                    source,
                    str(record.get("declared_license") or ""),
                    str(record.get("rights_status") or ""),
                    str(record.get("evidence_review_state") or ""),
                    str(len(record.get("unresolved_obligations", []))),
                ]
            )
            + " |"
        )
    lines.extend(["", "## First-party ownership", ""])
    for source, record in sorted(packet["first_party_sources"].items()):
        state = "ATTESTED" if not record["human_decision_required"] else "PENDING"
        lines.append(
            f"- {source}: {state}, scope {record['attestation_scope_sha256']}, "
            f"{len(record['files'])} pinned files."
        )
    lines.extend(
        [
            "",
            "## Pending decisions",
            "",
            "- External: "
            + (
                ", ".join(packet["decision_summary"]["external_pending"])
                if packet["decision_summary"]["external_pending"]
                else "none"
            ),
            "- First-party: "
            + (
                ", ".join(packet["decision_summary"]["first_party_pending"])
                if packet["decision_summary"]["first_party_pending"]
                else "none"
            ),
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    from workspace_paths import benchmark_root
    benchmarks = benchmark_root(root)
    config = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--plan", default=str(config / "imc_125m_production_sources.json")
    )
    parser.add_argument(
        "--inventory",
        default=str(benchmarks / "imc_125m_data_inventory" / "candidate-inventory.json"),
    )
    parser.add_argument("--rights", default=str(config / "data_rights.json"))
    parser.add_argument(
        "--evidence", default=str(config / "data_rights_evidence.json")
    )
    parser.add_argument(
        "--source-lock", default=str(config / "corpus_sources.lock.json")
    )
    parser.add_argument(
        "--git-source-lock", default=str(config / "git_sources.lock.json")
    )
    parser.add_argument(
        "--first-party-contracts",
        default=str(config / "first_party_tools_protocol.attestation.json"),
    )
    parser.add_argument(
        "--first-party-trajectories",
        default=str(config / "first_party_trajectories.attestation.json"),
    )
    parser.add_argument(
        "--first-party-math",
        default=str(config / "first_party_math.attestation.json"),
    )
    parser.add_argument("--first-party-root", default=str(root))
    parser.add_argument("--out", required=True)
    parser.add_argument("--markdown-out", default="")
    args = parser.parse_args()

    packet = build_review_packet(
        plan_path=args.plan,
        inventory_path=args.inventory,
        rights_path=args.rights,
        evidence_path=args.evidence,
        source_lock_path=args.source_lock,
        git_source_lock_path=args.git_source_lock,
        first_party_attestations={
            "first_party_contracts": args.first_party_contracts,
            "first_party_math": args.first_party_math,
            "first_party_trajectories": args.first_party_trajectories,
        },
        first_party_root=args.first_party_root,
    )
    atomic_write_json(args.out, packet)
    if args.markdown_out:
        Path(args.markdown_out).write_text(
            render_markdown(packet), encoding="utf-8", newline="\n"
        )
    print(
        f"[review-packet] {args.out}: {packet['review_packet_sha256']} "
        f"external_pending={len(packet['decision_summary']['external_pending'])} "
        f"first_party_pending={len(packet['decision_summary']['first_party_pending'])}"
    )


if __name__ == "__main__":
    main()
