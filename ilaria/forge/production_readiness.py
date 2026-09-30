"""Read-only readiness report for IlariaLex -> dataset -> IMC-125M production."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from corpus_source_lock import load_source_lock
from corpus_strategy import assess_strategy, load_strategy
from data_contract import load_rights_registry
from first_party_attestation import validate_attestation
from git_source_lock import load_lock as load_git_source_lock
from imc_125m_recipe import load_recipe
from prepare_corpus import SOURCES
from rights_evidence import load_and_validate_evidence


def assess_rights(
    registry: dict,
    evidence: dict,
    *,
    required_sources: list[str] | None = None,
) -> dict:
    blockers: list[str] = []
    approved: list[str] = []
    names = sorted(required_sources if required_sources is not None else registry["sources"])
    for name in names:
        reg = registry["sources"][name]
        ev = evidence["sources"].get(name, {})
        if reg.get("status") != "APPROVED":
            blockers.append(f"rights:{name}:status={reg.get('status')}")
            continue
        if reg.get("commercial_use_approved") is not True:
            blockers.append(f"rights:{name}:commercial_use_not_approved")
            continue
        if not str(reg.get("review_ref", "")).strip():
            blockers.append(f"rights:{name}:missing_review_ref")
            continue
        if ev.get("review_state") != "APPROVED":
            blockers.append(f"rights:{name}:evidence={ev.get('review_state')}")
            continue
        if ev.get("unresolved_obligations") != []:
            blockers.append(f"rights:{name}:unresolved_obligations")
            continue
        approved.append(name)
    return {
        "ready": not blockers,
        "approved_sources": approved,
        "blockers": blockers,
    }


def assess_artifact(path: str | Path, label: str) -> dict:
    target = Path(path)
    return {
        "label": label,
        "path": str(target),
        "exists": target.is_file(),
    }


def build_report(
    *,
    rights_path: str | Path,
    evidence_path: str | Path,
    source_lock_path: str | Path,
    recipe_path: str | Path,
    strategy_path: str | Path,
    git_source_lock_path: str | Path,
    first_party_attestation_path: str | Path,
    first_party_root: str | Path,
    coverage_manifest_path: str | Path,
    sample_manifest_path: str | Path,
    tokenizer_path: str | Path,
    freeze_path: str | Path,
    dataset_manifest_path: str | Path,
) -> dict:
    source_lock = load_source_lock(source_lock_path, SOURCES)
    rights = load_rights_registry(rights_path)
    evidence = load_and_validate_evidence(
        evidence_path,
        source_lock_path=source_lock_path,
        rights_registry_path=rights_path,
    )
    recipe = load_recipe(recipe_path)
    strategy = load_strategy(strategy_path)
    git_source_lock = load_git_source_lock(git_source_lock_path)
    attestation_path = Path(first_party_attestation_path)
    attestation_report = {
        "path": str(attestation_path),
        "exists": attestation_path.is_file(),
        "valid": False,
        "attestation_sha256": None,
        "error": None,
    }
    if attestation_path.is_file():
        try:
            attestation = validate_attestation(
                attestation_path,
                workspace_root=first_party_root,
            )
            attestation_report["valid"] = True
            attestation_report["attestation_sha256"] = attestation["attestation_sha256"]
        except ValueError as exc:
            attestation_report["error"] = str(exc)
    strategy_report = assess_strategy(
        strategy,
        set(git_source_lock["sources"]),
        first_party_attested=bool(attestation_report["valid"]),
    )
    preferred_registry_sources = sorted(
        {
            source
            for source in strategy_report["preferred_sources"].values()
            if source in rights["sources"]
        }
    )
    rights_report = assess_rights(
        rights,
        evidence,
        required_sources=preferred_registry_sources,
    )

    artifacts = [
        assess_artifact(coverage_manifest_path, "tokenizer_coverage_manifest"),
        assess_artifact(sample_manifest_path, "tokenizer_sample_manifest"),
        assess_artifact(tokenizer_path, "ilarialex_tokenizer"),
        assess_artifact(freeze_path, "ilarialex_freeze"),
        assess_artifact(dataset_manifest_path, "dataset_manifest"),
    ]
    blockers = list(rights_report["blockers"])
    blockers.extend(strategy_report["blockers"])
    if not attestation_report["valid"]:
        blockers.append(
            "first_party_attestation:"
            + (attestation_report["error"] or "missing")
        )
    blockers.extend(
        f"artifact:{item['label']}:missing" for item in artifacts if not item["exists"]
    )
    return {
        "format": "ilaria-production-readiness-v1",
        "ready": not blockers,
        "blockers": blockers,
        "rights": rights_report,
        "required_rights_sources": preferred_registry_sources,
        "source_lock_sha256": source_lock["source_lock_sha256"],
        "git_source_lock_sha256": git_source_lock["source_lock_sha256"],
        "git_sources": git_source_lock["sources"],
        "first_party_attestation": attestation_report,
        "corpus_strategy": {
            "policy": strategy["policy"],
            "lanes": sorted(strategy["lanes"]),
            **strategy_report,
        },
        "rights_evidence_sha256": evidence["evidence_sha256"],
        "imc_125m_recipe_sha256": recipe["recipe_file_sha256"],
        "artifacts": artifacts,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Path(__file__).resolve().parent / "config"
    production = root / "data" / "production"
    parser = argparse.ArgumentParser()
    parser.add_argument("--rights", default=str(config / "data_rights.json"))
    parser.add_argument("--evidence", default=str(config / "data_rights_evidence.json"))
    parser.add_argument("--source-lock", default=str(config / "corpus_sources.lock.json"))
    parser.add_argument("--recipe", default=str(config / "imc_125m_recipe.json"))
    parser.add_argument("--strategy", default=str(config / "corpus_strategy.json"))
    parser.add_argument("--git-source-lock", default=str(config / "git_sources.lock.json"))
    parser.add_argument(
        "--first-party-attestation",
        default=str(config / "first_party_tools_protocol.attestation.json"),
    )
    parser.add_argument("--coverage-manifest", default=str(production / "ilarialex.coverage.json"))
    parser.add_argument("--sample-manifest", default=str(production / "ilarialex.sample.manifest.json"))
    parser.add_argument("--tokenizer", default=str(production / "ilarialex.json"))
    parser.add_argument("--freeze", default=str(production / "ilarialex.freeze.json"))
    parser.add_argument("--dataset-manifest", default=str(production / "dataset.manifest.json"))
    args = parser.parse_args()
    report = build_report(
        rights_path=args.rights,
        evidence_path=args.evidence,
        source_lock_path=args.source_lock,
        recipe_path=args.recipe,
        strategy_path=args.strategy,
        git_source_lock_path=args.git_source_lock,
        first_party_attestation_path=args.first_party_attestation,
        first_party_root=root,
        coverage_manifest_path=args.coverage_manifest,
        sample_manifest_path=args.sample_manifest,
        tokenizer_path=args.tokenizer,
        freeze_path=args.freeze,
        dataset_manifest_path=args.dataset_manifest,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
