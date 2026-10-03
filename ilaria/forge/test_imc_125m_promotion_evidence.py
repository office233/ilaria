from __future__ import annotations

import copy

import pytest

from data_contract import canonical_json_sha256
from imc_125m_launch import build_launch_manifest
from imc_125m_promotion_evidence import (
    build_promotion_evidence,
    validate_eval_result,
)


def recipe():
    return {
        "recipe_file_sha256": "a" * 64,
        "preset": "imc-125m",
        "vocab_size": 65_536,
        "context": 2_048,
        "max_seq_len": 2_048,
        "target_tokens": 1_000_000_000,
        "global_batch_tokens": 262_144,
        "curriculum_resolved": {
            "identity_sha256": "f" * 64,
            "target_mix_ppm": {
            "general_knowledge": 300000,
            "code": 220000,
            "mathematics": 145000,
            "science_technical_reasoning": 105000,
            "os_hardware_drivers_standards": 100000,
            "agent_tool_trajectories": 80000,
            "romanian_multilingual": 0,
            "world_device_trajectories": 50000,
            },
        },
        "optimizer": {
            "lr": 0.0006, "min_lr": 0.00006, "warmup_steps": 200,
            "weight_decay": 0.1, "beta1": 0.9, "beta2": 0.95,
            "adam_eps": 1e-8, "grad_clip": 1.0, "lr_schedule": "cosine",
        },
        "execution": {"chunked_loss": True, "grad_checkpoint": True, "precision": "auto"},
        "experiments": [
            {"name": "ternary_candidate", "ternary": True, "seeds": [7, 11]},
            {"name": "full_precision_control", "ternary": False, "seeds": [7, 11]},
        ],
        "required_evaluations": ["frozen_validation", "code"],
    }


def readiness():
    return {
        "ready": True,
        "dataset_manifest_sha256": "b" * 64,
        "freeze_sha256": "c" * 64,
        "tokenizer_sha256": "d" * 64,
        "parameter_count": 125_882_112,
        "curriculum_sha256": "f" * 64,
    }


def paths(seed):
    return {
        "train_data": "/data/train",
        "validation_data": "/data/validation",
        "dataset_manifest": "/data/dataset.manifest.json",
        "tokenizer_freeze": "/data/ilarialex.freeze.json",
        "tokenizer": "/data/ilarialex.json",
        "output_dir": f"/runs/{seed}",
    }


def launches():
    out = []
    for experiment in recipe()["experiments"]:
        for seed in experiment["seeds"]:
            out.append(
                build_launch_manifest(
                    recipe(), readiness(),
                    experiment_name=experiment["name"], seed=seed,
                    world_size=1, micro_batch=4, paths=paths(seed),
                )
            )
    return out


def eval_result(launch, evaluation, *, passed=True):
    value = {
        "format": "imc-125m-eval-result-v1",
        "launch_sha256": launch["launch_sha256"],
        "checkpoint_sha256": (launch["launch_sha256"][:32] * 2),
        "evaluation": evaluation,
        "evaluator": f"eval-{evaluation}",
        "evaluator_version": "v1",
        "dataset_sha256": "e" * 64,
        "passed": passed,
        "metrics": {"score": 0.75},
    }
    value["result_sha256"] = canonical_json_sha256(value)
    return value


def complete_results(run_launches, *, fail_one=False):
    results = []
    for index, launch in enumerate(run_launches):
        for evaluation in recipe()["required_evaluations"]:
            results.append(
                eval_result(
                    launch, evaluation,
                    passed=not (fail_one and index == 0 and evaluation == "code"),
                )
            )
    return results


def test_complete_passing_matrix_is_ready_for_promotion_review():
    run_launches = launches()
    evidence = build_promotion_evidence(
        recipe(), run_launches, complete_results(run_launches)
    )
    assert evidence["ready_for_promotion_review"] is True
    assert evidence["expected_runs"] == 4
    assert len(evidence["runs"]) == 4
    assert len(evidence["evidence_sha256"]) == 64


def test_failed_evaluation_blocks_review_without_hiding_evidence():
    run_launches = launches()
    evidence = build_promotion_evidence(
        recipe(), run_launches, complete_results(run_launches, fail_one=True)
    )
    assert evidence["ready_for_promotion_review"] is False
    assert evidence["all_evaluations_passed"] is False
    failed_runs = [run for run in evidence["runs"] if run["failed_evaluations"]]
    assert len(failed_runs) == 1
    assert failed_runs[0]["failed_evaluations"] == ["code"]


def test_missing_evaluation_fails_closed():
    run_launches = launches()
    results = complete_results(run_launches)
    results.pop()
    with pytest.raises(ValueError, match="missing evaluations"):
        build_promotion_evidence(recipe(), run_launches, results)


def test_missing_locked_run_fails_closed():
    run_launches = launches()[:-1]
    with pytest.raises(ValueError, match="launch matrix mismatch"):
        build_promotion_evidence(recipe(), run_launches, complete_results(run_launches))


def test_eval_result_rejects_nonfinite_metric_and_tampering():
    launch = launches()[0]
    result = eval_result(launch, "code")
    result["metrics"]["score"] = float("nan")
    with pytest.raises(ValueError, match="non-finite"):
        validate_eval_result(result)

    clean = eval_result(launch, "code")
    tampered = copy.deepcopy(clean)
    tampered["passed"] = False
    with pytest.raises(ValueError, match="identity hash mismatch"):
        validate_eval_result(tampered)
