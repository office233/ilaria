"""Read-only readiness report for IlariaLex -> dataset -> IMC-125M production."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from benchmark_exclusion_plan import assess_plan as assess_benchmark_exclusions
from corpus_source_lock import load_source_lock
from corpus_strategy import assess_strategy, load_strategy
from data_contract import load_rights_registry
from first_party_attestation import validate_attestation
from git_source_lock import load_lock as load_git_source_lock
from imc_125m_recipe import load_recipe
from prepare_corpus import SOURCES
from production_source_plan import (
    assess_plan as assess_production_source_plan,
    load_inventory as load_candidate_inventory,
    load_plan as load_production_source_plan,
)
from rights_evidence import load_and_validate_evidence
from verified_trajectory_corpus import evaluate_quality, load_generation_config
from verified_math_corpus import (
    evaluate_quality as evaluate_math_quality,
    load_config as load_math_generation_config,
)


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
        reg = registry["sources"].get(name)
        if not isinstance(reg, dict):
            blockers.append(f"rights:{name}:missing_registry_source")
            continue
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


def assess_first_party_attestation(
    path: str | Path, *, workspace_root: str | Path
) -> dict:
    target = Path(path)
    report = {
        "path": str(target),
        "exists": target.is_file(),
        "valid": False,
        "attestation_sha256": None,
        "error": None,
    }
    if target.is_file():
        try:
            attestation = validate_attestation(
                target,
                workspace_root=workspace_root,
            )
            report["valid"] = True
            report["attestation_sha256"] = attestation["attestation_sha256"]
        except (OSError, ValueError) as exc:
            report["error"] = str(exc)
    return report


def assess_trajectory_quality(
    path: str | Path, *, generation_config_path: str | Path
) -> dict:
    target = Path(path)
    report = {
        "path": str(target),
        "exists": target.is_file(),
        "valid": False,
        "quality_gate_sha256": None,
        "error": None,
    }
    if not target.is_file():
        return report
    try:
        with target.open(encoding="utf-8") as stream:
            observed = json.load(stream)
        expected = evaluate_quality(load_generation_config(generation_config_path))
        if observed != expected:
            raise ValueError("trajectory quality report differs from canonical recomputation")
        report["valid"] = True
        report["quality_gate_sha256"] = expected["quality_gate_sha256"]
    except (OSError, ValueError) as exc:
        report["error"] = str(exc)
    return report


def assess_math_quality(
    path: str | Path, *, generation_config_path: str | Path
) -> dict:
    target = Path(path)
    report = {
        "path": str(target),
        "exists": target.is_file(),
        "valid": False,
        "quality_gate_sha256": None,
        "error": None,
    }
    if not target.is_file():
        return report
    try:
        with target.open(encoding="utf-8") as stream:
            observed = json.load(stream)
        expected = evaluate_math_quality(load_math_generation_config(generation_config_path))
        if observed != expected:
            raise ValueError("math quality report differs from canonical recomputation")
        report["valid"] = True
        report["quality_gate_sha256"] = expected["quality_gate_sha256"]
    except (OSError, ValueError) as exc:
        report["error"] = str(exc)
    return report


def build_report(
    *,
    rights_path: str | Path,
    evidence_path: str | Path,
    source_lock_path: str | Path,
    recipe_path: str | Path,
    strategy_path: str | Path,
    source_plan_path: str | Path,
    inventory_path: str | Path,
    git_source_lock_path: str | Path,
    first_party_attestation_path: str | Path,
    trajectory_attestation_path: str | Path,
    first_party_root: str | Path,
    trajectory_generation_config_path: str | Path,
    trajectory_quality_path: str | Path,
    coverage_manifest_path: str | Path,
    sample_manifest_path: str | Path,
    tokenizer_path: str | Path,
    freeze_path: str | Path,
    dataset_manifest_path: str | Path,
    benchmark_plan_path: str | Path | None = None,
    math_attestation_path: str | Path | None = None,
    math_generation_config_path: str | Path | None = None,
    math_quality_path: str | Path | None = None,
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
    source_plan = load_production_source_plan(source_plan_path)
    inventory = load_candidate_inventory(inventory_path)
    source_plan_report = assess_production_source_plan(source_plan, inventory)
    git_source_lock = load_git_source_lock(git_source_lock_path)
    attestation_report = assess_first_party_attestation(
        first_party_attestation_path,
        workspace_root=first_party_root,
    )
    trajectory_attestation_report = assess_first_party_attestation(
        trajectory_attestation_path,
        workspace_root=first_party_root,
    )
    trajectory_quality_report = assess_trajectory_quality(
        trajectory_quality_path,
        generation_config_path=trajectory_generation_config_path,
    )
    math_attestation_report = (
        assess_first_party_attestation(
            math_attestation_path,
            workspace_root=first_party_root,
        )
        if math_attestation_path is not None
        else {
            "path": None,
            "exists": False,
            "valid": False,
            "attestation_sha256": None,
            "error": "missing",
        }
    )
    math_quality_report = (
        assess_math_quality(
            math_quality_path,
            generation_config_path=math_generation_config_path,
        )
        if math_quality_path is not None and math_generation_config_path is not None
        else {
            "path": None,
            "exists": False,
            "valid": False,
            "quality_gate_sha256": None,
            "error": "missing",
        }
    )
    attested_sources = set()
    if attestation_report["valid"]:
        attested_sources.add("first_party_contracts")
    if trajectory_attestation_report["valid"]:
        attested_sources.add("first_party_trajectories")
    if math_attestation_report["valid"]:
        attested_sources.add("first_party_math")
    strategy_report = assess_strategy(
        strategy,
        set(git_source_lock["sources"]),
        first_party_attested_sources=attested_sources,
    )
    required_registry_sources = list(source_plan_report["required_external_sources"])
    rights_report = assess_rights(
        rights,
        evidence,
        required_sources=required_registry_sources,
    )
    benchmark_report = (
        assess_benchmark_exclusions(
            benchmark_plan_path,
            workspace_root=first_party_root,
        )
        if benchmark_plan_path is not None
        else None
    )

    artifacts = [
        assess_artifact(coverage_manifest_path, "tokenizer_coverage_manifest"),
        assess_artifact(sample_manifest_path, "tokenizer_sample_manifest"),
        assess_artifact(tokenizer_path, "ilarialex_tokenizer"),
        assess_artifact(freeze_path, "ilarialex_freeze"),
        assess_artifact(dataset_manifest_path, "dataset_manifest"),
    ]
    blockers = list(rights_report["blockers"])
    blockers.extend(source_plan_report["blockers"])
    if benchmark_report is not None:
        blockers.extend(benchmark_report["blockers"])
    required_first_party = set(source_plan_report["required_first_party_sources"])
    if "first_party_contracts" in required_first_party and not attestation_report["valid"]:
        blockers.append(
            "first_party_attestation:first_party_contracts:"
            + (attestation_report["error"] or "missing")
        )
    if (
        "first_party_trajectories" in required_first_party
        and not trajectory_attestation_report["valid"]
    ):
        blockers.append(
            "first_party_attestation:first_party_trajectories:"
            + (trajectory_attestation_report["error"] or "missing")
        )
    if (
        "first_party_trajectories" in required_first_party
        and not trajectory_quality_report["valid"]
    ):
        blockers.append(
            "trajectory_quality:"
            + (trajectory_quality_report["error"] or "missing")
        )
    if "first_party_math" in required_first_party and not math_attestation_report["valid"]:
        blockers.append(
            "first_party_attestation:first_party_math:"
            + (math_attestation_report["error"] or "missing")
        )
    if "first_party_math" in required_first_party and not math_quality_report["valid"]:
        blockers.append(
            "math_quality:" + (math_quality_report["error"] or "missing")
        )
    blockers.extend(
        f"artifact:{item['label']}:missing" for item in artifacts if not item["exists"]
    )
    return {
        "format": "ilaria-production-readiness-v1",
        "ready": not blockers,
        "blockers": blockers,
        "rights": rights_report,
        "required_rights_sources": required_registry_sources,
        "source_lock_sha256": source_lock["source_lock_sha256"],
        "git_source_lock_sha256": git_source_lock["source_lock_sha256"],
        "git_sources": git_source_lock["sources"],
        "first_party_attestation": attestation_report,
        "first_party_attestations": {
            "first_party_contracts": attestation_report,
            "first_party_math": math_attestation_report,
            "first_party_trajectories": trajectory_attestation_report,
        },
        "trajectory_quality": trajectory_quality_report,
        "math_quality": math_quality_report,
        **(
            {"benchmark_exclusions": benchmark_report}
            if benchmark_report is not None
            else {}
        ),
        "source_plan": source_plan_report,
        "corpus_strategy": {
            "enforced": False,
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
    from workspace_paths import benchmark_root
    benchmarks = benchmark_root(root)
    config = Path(__file__).resolve().parent / "config"
    production = root / "data" / "production"
    parser = argparse.ArgumentParser()
    parser.add_argument("--rights", default=str(config / "data_rights.json"))
    parser.add_argument("--evidence", default=str(config / "data_rights_evidence.json"))
    parser.add_argument("--source-lock", default=str(config / "corpus_sources.lock.json"))
    parser.add_argument("--recipe", default=str(config / "imc_125m_recipe.json"))
    parser.add_argument("--strategy", default=str(config / "corpus_strategy.json"))
    parser.add_argument(
        "--source-plan",
        default=str(config / "imc_125m_production_sources.json"),
    )
    parser.add_argument(
        "--inventory",
        default=str(benchmarks / "imc_125m_data_inventory" / "candidate-inventory.json"),
    )
    parser.add_argument("--git-source-lock", default=str(config / "git_sources.lock.json"))
    parser.add_argument(
        "--first-party-attestation",
        default=str(config / "first_party_tools_protocol.attestation.json"),
    )
    parser.add_argument(
        "--trajectory-attestation",
        default=str(config / "first_party_trajectories.attestation.json"),
    )
    parser.add_argument(
        "--trajectory-generation-config",
        default=str(config / "imc_125m_trajectory_generation.json"),
    )
    parser.add_argument(
        "--trajectory-quality",
        default=str(benchmarks / "imc_125m_trajectory_quality" / "RESULTS.json"),
    )
    parser.add_argument(
        "--math-attestation",
        default=str(config / "first_party_math.attestation.json"),
    )
    parser.add_argument(
        "--math-generation-config",
        default=str(config / "imc_125m_math_generation.json"),
    )
    parser.add_argument(
        "--math-quality",
        default=str(benchmarks / "imc_125m_math_quality" / "RESULTS.json"),
    )
    parser.add_argument(
        "--benchmark-exclusions",
        default=str(config / "imc_125m_benchmark_exclusions.json"),
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
        source_plan_path=args.source_plan,
        inventory_path=args.inventory,
        git_source_lock_path=args.git_source_lock,
        first_party_attestation_path=args.first_party_attestation,
        trajectory_attestation_path=args.trajectory_attestation,
        first_party_root=root,
        trajectory_generation_config_path=args.trajectory_generation_config,
        trajectory_quality_path=args.trajectory_quality,
        coverage_manifest_path=args.coverage_manifest,
        sample_manifest_path=args.sample_manifest,
        tokenizer_path=args.tokenizer,
        freeze_path=args.freeze,
        dataset_manifest_path=args.dataset_manifest,
        benchmark_plan_path=args.benchmark_exclusions,
        math_attestation_path=args.math_attestation,
        math_generation_config_path=args.math_generation_config,
        math_quality_path=args.math_quality,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
