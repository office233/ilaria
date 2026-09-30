"""Integrity/completeness gate for IMC-125M promotion evidence.

This module deliberately does not invent benchmark thresholds. Individual
evaluators own their pass/fail contracts; this gate proves that every locked
run and every recipe-required evaluation is present, content-addressed and
passing before a human/scientific promotion review can begin.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

try:
    from .data_contract import canonical_json_sha256, require_lower_sha256
    from .imc_125m_launch import validate_launch_manifest
    from .imc_125m_recipe import load_recipe
except ImportError:  # direct script execution
    from data_contract import canonical_json_sha256, require_lower_sha256
    from imc_125m_launch import validate_launch_manifest
    from imc_125m_recipe import load_recipe

EVAL_RESULT_FORMAT = "imc-125m-eval-result-v1"
EVIDENCE_FORMAT = "imc-125m-promotion-evidence-v1"


def _identity_hash(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def validate_eval_result(result: dict) -> dict:
    if not isinstance(result, dict) or result.get("format") != EVAL_RESULT_FORMAT:
        raise ValueError("unsupported IMC-125M evaluation result format")
    for field in ("launch_sha256", "checkpoint_sha256", "dataset_sha256"):
        require_lower_sha256(field, result.get(field, ""))
    for field in ("evaluation", "evaluator", "evaluator_version"):
        if not isinstance(result.get(field), str) or not result[field].strip():
            raise ValueError(f"IMC-125M evaluation result {field} is invalid")
    if type(result.get("passed")) is not bool:
        raise ValueError("IMC-125M evaluation result passed must be boolean")
    metrics = result.get("metrics")
    if not isinstance(metrics, dict) or not metrics:
        raise ValueError("IMC-125M evaluation result has no metrics")
    for name, value in metrics.items():
        if not isinstance(name, str) or not name:
            raise ValueError("IMC-125M evaluation metric name is invalid")
        if type(value) not in (int, float) or not math.isfinite(float(value)):
            raise ValueError(f"IMC-125M evaluation metric {name!r} is non-finite")
    declared = result.get("result_sha256", "")
    require_lower_sha256("result_sha256", declared)
    if _identity_hash(result, "result_sha256") != declared:
        raise ValueError("IMC-125M evaluation result identity hash mismatch")
    return result


def load_eval_result(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        return validate_eval_result(json.load(stream))


def _expected_runs(recipe: dict) -> set[tuple[str, int]]:
    return {
        (experiment["name"], seed)
        for experiment in recipe["experiments"]
        for seed in experiment["seeds"]
    }


def build_promotion_evidence(
    recipe: dict,
    launch_manifests: list[dict],
    evaluation_results: list[dict],
) -> dict:
    expected_runs = _expected_runs(recipe)
    required_evaluations = set(recipe["required_evaluations"])
    if not required_evaluations:
        raise ValueError("IMC-125M recipe has no required evaluations")

    launches: dict[tuple[str, int], dict] = {}
    launch_by_hash: dict[str, dict] = {}
    for raw in launch_manifests:
        launch = validate_launch_manifest(raw)
        if launch.get("recipe_sha256") != recipe["recipe_file_sha256"]:
            raise ValueError("IMC-125M launch references a different recipe")
        key = (launch["experiment"]["name"], int(launch["experiment"]["seed"]))
        if key in launches:
            raise ValueError(f"duplicate IMC-125M launch for {key!r}")
        launches[key] = launch
        launch_by_hash[launch["launch_sha256"]] = launch
    if set(launches) != expected_runs:
        missing = sorted(expected_runs - set(launches))
        extra = sorted(set(launches) - expected_runs)
        raise ValueError(f"IMC-125M launch matrix mismatch: missing={missing}, extra={extra}")

    per_launch: dict[str, dict[str, dict]] = {
        launch_hash: {} for launch_hash in launch_by_hash
    }
    checkpoint_by_launch: dict[str, str] = {}
    for raw in evaluation_results:
        result = validate_eval_result(raw)
        launch_hash = result["launch_sha256"]
        if launch_hash not in launch_by_hash:
            raise ValueError("evaluation result references an unknown launch")
        evaluation = result["evaluation"]
        if evaluation not in required_evaluations:
            raise ValueError(f"unexpected IMC-125M evaluation {evaluation!r}")
        if evaluation in per_launch[launch_hash]:
            raise ValueError(
                f"duplicate IMC-125M evaluation {evaluation!r} for launch {launch_hash}"
            )
        checkpoint = checkpoint_by_launch.setdefault(
            launch_hash, result["checkpoint_sha256"]
        )
        if checkpoint != result["checkpoint_sha256"]:
            raise ValueError("evaluation results disagree on checkpoint hash for one launch")
        per_launch[launch_hash][evaluation] = result

    run_records = []
    all_passed = True
    for key in sorted(expected_runs):
        launch = launches[key]
        launch_hash = launch["launch_sha256"]
        observed = per_launch[launch_hash]
        missing = sorted(required_evaluations - set(observed))
        if missing:
            raise ValueError(f"launch {key!r} is missing evaluations: {missing}")
        failed = sorted(
            name for name, result in observed.items() if result["passed"] is not True
        )
        all_passed = all_passed and not failed
        run_records.append(
            {
                "experiment": key[0],
                "seed": key[1],
                "launch_sha256": launch_hash,
                "checkpoint_sha256": checkpoint_by_launch[launch_hash],
                "evaluation_result_sha256": {
                    name: observed[name]["result_sha256"]
                    for name in sorted(required_evaluations)
                },
                "failed_evaluations": failed,
            }
        )

    evidence = {
        "format": EVIDENCE_FORMAT,
        "recipe_sha256": recipe["recipe_file_sha256"],
        "expected_runs": len(expected_runs),
        "required_evaluations": sorted(required_evaluations),
        "all_evaluations_passed": all_passed,
        "ready_for_promotion_review": all_passed,
        "runs": run_records,
    }
    evidence["evidence_sha256"] = _identity_hash(evidence, "evidence_sha256")
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", required=True)
    parser.add_argument("--launch", action="append", required=True)
    parser.add_argument("--evaluation", action="append", required=True)
    args = parser.parse_args()
    recipe = load_recipe(args.recipe)
    launches = []
    for path in args.launch:
        with Path(path).open(encoding="utf-8") as stream:
            launches.append(json.load(stream))
    evaluations = [load_eval_result(path) for path in args.evaluation]
    evidence = build_promotion_evidence(recipe, launches, evaluations)
    print(json.dumps(evidence, indent=2, sort_keys=True))
    if not evidence["ready_for_promotion_review"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
