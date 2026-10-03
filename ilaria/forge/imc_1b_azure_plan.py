"""Validate an IMC-1B preparation plan and print a non-authorizing report.

This module reads public plan/curriculum/model sources only. Production paths
are strings in an argv template: their presence never proves dataset readiness.
It never executes that template, probes hardware, loads weights or starts jobs.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path

from curriculum_stream import allocate_token_budget, load_curriculum
from data_contract import atomic_write_json, canonical_json_sha256, require_lower_sha256, sha256_file
from imc_125m_recipe import resolve_execution
from imc_model import ImcConfig

CONFIG = Path(__file__).resolve().parent / "config"
DEFAULT_PLAN = CONFIG / "imc_1b_azure_plan.json"
PLAN_FORMAT = "imc-1b-azure-plan-v1"
REPORT_FORMAT = "imc-1b-azure-preparation-v1"
EXPECTED_PARAMS = 1_000_555_520
CURRICULUM_SHA256 = "3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432"
PROFILES = {
    "a100-40gb-2k": (40, 2048, "baseline"),
    "a100-80gb-2k": (80, 2048, "baseline"),
    "a100-40gb-4k-candidate": (40, 4096, "candidate"),
    "a100-80gb-4k-candidate": (80, 4096, "candidate"),
}
REQUIRED_GATES = [
    "production_dataset_20b", "frozen_validation_20m_and_prior_holdouts",
    "frozen_tokenizer_and_lineage", "eight_full_a100_hardware_topology",
    "eight_rank_nccl_smoke", "eight_rank_exact_resume", "measured_memory_throughput",
    "approved_time_cost_budget", "frozen_capability_evaluations",
    "immutable_checkpoint_generations_restart", "azure_ddp_orchestration",
    "rank_local_cuda_rng_scope",
]
PATH_FLAGS = {
    "train_data": "--data", "validation_data": "--val-data", "output_dir": "--out",
    "tokenizer": "--tokenizer", "dataset_manifest": "--dataset-manifest",
    "tokenizer_freeze": "--tokenizer-freeze", "first_party_root": "--first-party-root",
    "first_party_contracts": "--first-party-attestation",
}


def _keys(value: object, expected: str, label: str) -> dict:
    if not isinstance(value, dict) or set(value) != set(expected.split()):
        raise ValueError(f"{label} fields mismatch")
    return value


def _integer(value: object, label: str, minimum: int = 1) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _number(value: object, label: str, minimum: float = 0.0, *, positive: bool = False) -> float:
    if (type(value) not in (int, float) or not math.isfinite(value)
            or value < minimum or (positive and value == minimum)):
        raise ValueError(f"{label} must be finite and {'>' if positive else '>='} {minimum}")
    return value


def plan_identity(plan: dict) -> str:
    return canonical_json_sha256({key: value for key, value in plan.items() if key != "plan_sha256"})


def validate_plan(plan: dict) -> dict:
    """Return an independent validated plan; validation cannot authorize a run."""
    _keys(plan, "format status plan_sha256 model experiment target_tokens global_batch_tokens "
          "world_size curriculum optimizer execution evaluation required_dataset profiles required_gates", "plan")
    require_lower_sha256("plan_sha256", plan["plan_sha256"])
    if plan["plan_sha256"] != plan_identity(plan):
        raise ValueError("plan content hash drifted")
    if plan["format"] != PLAN_FORMAT or plan["status"] != "PLANNED_NOT_READY":
        raise ValueError("plan must remain PLANNED_NOT_READY")
    for field, expected in (("target_tokens", 20_000_000_000), ("global_batch_tokens", 524_288), ("world_size", 8)):
        if _integer(plan[field], field) != expected:
            raise ValueError(f"{field} must be {expected}")
    model = _keys(plan["model"], "family preset parameter_count vocab_size eos_token_id initialization weight_mode ffn_act", "model")
    expected_model = {"family": "IMC", "preset": "imc-1b", "parameter_count": EXPECTED_PARAMS,
                      "vocab_size": 65536, "eos_token_id": 61440, "initialization": "random",
                      "weight_mode": model["weight_mode"], "ffn_act": "silu"}
    for field in ("parameter_count", "vocab_size", "eos_token_id"):
        _integer(model[field], f"model.{field}")
    if model != expected_model:
        raise ValueError("model must use canonical random-initialized IMC-1B")
    cfg = ImcConfig.preset("imc-1b", vocab_size=model["vocab_size"], eos_token_id=model["eos_token_id"])
    if cfg.param_count() != EXPECTED_PARAMS:
        raise ValueError("canonical IMC-1B parameter count drifted")
    experiment = _keys(plan["experiment"], "name ternary seed", "experiment")
    if not ((experiment["name"] == "ternary_candidate" and experiment["ternary"] is True and model["weight_mode"] == "ternary")
            or (experiment["name"] == "full_precision_control" and experiment["ternary"] is False and model["weight_mode"] == "full_precision")):
        raise ValueError("ineligible experiment")
    _integer(experiment["seed"], "seed", 0)
    curriculum = _keys(plan["curriculum"], "filename identity_sha256", "curriculum")
    resolved = load_curriculum(CONFIG / "imc_125m_curriculum.json")
    if (curriculum["filename"] != "imc_125m_curriculum.json"
            or curriculum["identity_sha256"] != CURRICULUM_SHA256
            or resolved["curriculum_sha256"] != CURRICULUM_SHA256):
        raise ValueError("canonical curriculum identity drifted")
    optimizer = _keys(plan["optimizer"], "name lr min_lr warmup_steps weight_decay beta1 beta2 adam_eps grad_clip lr_schedule", "optimizer")
    if optimizer["name"] != "AdamW" or optimizer["lr_schedule"] != "cosine":
        raise ValueError("optimizer requires AdamW and cosine schedule")
    _number(optimizer["lr"], "lr", positive=True)
    _number(optimizer["min_lr"], "min_lr")
    if optimizer["min_lr"] > optimizer["lr"]:
        raise ValueError("min_lr exceeds lr")
    _number(optimizer["weight_decay"], "weight_decay")
    _number(optimizer["grad_clip"], "grad_clip", positive=True)
    _number(optimizer["adam_eps"], "adam_eps", positive=True)
    for field in ("beta1", "beta2"):
        if _number(optimizer[field], field) >= 1:
            raise ValueError(f"{field} must be below 1")
    _integer(optimizer["warmup_steps"], "warmup_steps", 0)
    execution = _keys(plan["execution"], "precision chunked_loss grad_checkpoint compile sample_tokens", "execution")
    if (execution["precision"] != "bf16" or execution["chunked_loss"] is not True
            or execution["grad_checkpoint"] is not True or execution["compile"] is not False
            or _integer(execution["sample_tokens"], "sample_tokens", 0) != 0):
        raise ValueError("execution requires BF16, checkpointing, chunked loss, no compile or samples")
    evaluation = _keys(plan["evaluation"], "every_steps iterations status", "evaluation")
    _integer(evaluation["every_steps"], "every_steps")
    _integer(evaluation["iterations"], "iterations")
    if evaluation["status"] != "PROVISIONAL":
        raise ValueError("evaluation must remain PROVISIONAL")
    dataset = _keys(plan["required_dataset"], "minimum_train_tokens minimum_validation_tokens preserve_prior_holdouts token_budget_semantics", "required_dataset")
    _integer(dataset["minimum_train_tokens"], "minimum_train_tokens", plan["target_tokens"])
    _integer(dataset["minimum_validation_tokens"], "minimum_validation_tokens", 20_000_000)
    if (dataset["preserve_prior_holdouts"] is not True
            or dataset["token_budget_semantics"] != "processed_tokens_not_unique_source_tokens"):
        raise ValueError("dataset must preserve holdouts and distinguish processed from unique tokens")
    profiles = plan["profiles"]
    if not isinstance(profiles, list) or len(profiles) != len(PROFILES):
        raise ValueError("plan requires all four provisional profiles")
    seen = set()
    for profile in profiles:
        _keys(profile, "name gpu_memory_gb context max_seq_len micro_batch accum role status", "profile")
        name = profile["name"]
        if not isinstance(name, str) or name not in PROFILES or name in seen:
            raise ValueError("unknown or repeated profile")
        seen.add(name)
        for field in ("gpu_memory_gb", "context", "max_seq_len", "micro_batch", "accum"):
            _integer(profile[field], f"profile.{field}")
        expected = PROFILES[name]
        values = tuple(profile[field] for field in ("gpu_memory_gb", "context", "role"))
        if (values != expected or profile["max_seq_len"] != profile["context"]
                or profile["status"] != "UNBENCHMARKED"):
            raise ValueError("provisional profile drifted")
        accounting = resolve_execution(plan | {"context": profile["context"]}, world_size=plan["world_size"], micro_batch=profile["micro_batch"])
        if accounting["accum"] != profile["accum"] or optimizer["warmup_steps"] >= accounting["steps"]:
            raise ValueError("profile accumulation or warmup is incompatible with the horizon")
    if plan["required_gates"] != REQUIRED_GATES:
        raise ValueError("required preparation gates drifted")
    return copy.deepcopy(plan)


def load_plan(path: str | Path = DEFAULT_PLAN) -> dict:
    return validate_plan(json.loads(Path(path).read_text(encoding="utf-8")))


def _paths(paths: dict | None) -> dict[str, str]:
    if paths is None:
        return {name: f"<REQUIRED_{name.upper()}>" for name in PATH_FLAGS}
    if not isinstance(paths, dict) or set(paths) != set(PATH_FLAGS):
        raise ValueError("production paths must be supplied all-or-none")
    if any(not isinstance(value, str) or not value.strip() or any(c in value for c in "\0\r\n") for value in paths.values()):
        raise ValueError("production paths must be nonempty single-line strings")
    return dict(paths)


def build_planning_report(plan: dict, profile_name: str, paths: dict | None = None) -> dict:
    plan = validate_plan(plan)
    if profile_name not in PROFILES:
        raise ValueError("unknown profile")
    profile = next(item for item in plan["profiles"] if item["name"] == profile_name)
    execution = resolve_execution(plan | {"context": profile["context"]}, world_size=plan["world_size"], micro_batch=profile["micro_batch"])
    cfg = ImcConfig.preset("imc-1b", vocab_size=65536, eos_token_id=61440, max_seq_len=profile["context"], ternary=plan["experiment"]["ternary"])
    mix = load_curriculum(CONFIG / "imc_125m_curriculum.json")["target_mix_ppm"]
    argv = ["torchrun", "--standalone", f"--nproc_per_node={plan['world_size']}", "forge/train_ilaria.py"]
    paths = _paths(paths)
    for name, flag in PATH_FLAGS.items():
        value = paths[name]
        argv += [flag, f"first_party_contracts={value}" if name == "first_party_contracts" else value]
    values = {"--preset": "imc-1b", "--ffn-act": "silu", "--ctx": profile["context"],
              "--max-seq-len": profile["max_seq_len"], "--batch": profile["micro_batch"],
              "--accum": execution["accum"], "--target-tokens": plan["target_tokens"],
              "--seed": plan["experiment"]["seed"], "--precision": "bf16", "--sample-tokens": 0,
              "--eval-every": plan["evaluation"]["every_steps"], "--eval-iters": plan["evaluation"]["iterations"]}
    optimizer_flags = {"--warmup": "warmup_steps", "--lr": "lr", "--min-lr": "min_lr",
                       "--lr-schedule": "lr_schedule", "--wd": "weight_decay", "--beta1": "beta1",
                       "--beta2": "beta2", "--adam-eps": "adam_eps", "--grad-clip": "grad_clip"}
    values.update({flag: plan["optimizer"][field] for flag, field in optimizer_flags.items()})
    for flag, value in values.items():
        argv += [flag, str(value)]
    argv += ["--chunked-loss", "--grad-checkpoint"]
    if plan["experiment"]["ternary"]:
        argv.append("--ternary")
    report = {
        "format": REPORT_FORMAT, "status": "PREPARATION_ONLY", "launch_ready": False,
        "execution_authorized": False, "plan_sha256": plan["plan_sha256"],
        "profile": profile, "model_config": cfg.to_json(),
        "model_source_sha256": sha256_file(Path(__file__).resolve().parent / "imc_model.py"),
        "trainer_source_sha256": sha256_file(Path(__file__).resolve().parent / "train_ilaria.py"),
        "execution": execution, "experiment": plan["experiment"], "optimizer": plan["optimizer"],
        "curriculum_sha256": CURRICULUM_SHA256, "curriculum_mix_ppm": mix,
        "lane_token_budgets": allocate_token_budget(plan["target_tokens"], mix),
        "validation_lane_token_budgets": allocate_token_budget(plan["required_dataset"]["minimum_validation_tokens"], mix),
        "required_dataset": plan["required_dataset"] | {"availability": "MISSING", "eligibility_verified": False},
        "evaluation": plan["evaluation"] | {"validation_tokens_per_evaluation": profile["micro_batch"] * profile["context"] * plan["evaluation"]["iterations"]},
        "profile_fit_verified": False, "cross_profile_exact_resume_allowed": False,
        "missing_gates": list(REQUIRED_GATES), "command_argv_template": argv,
        "command_paths_verified": False,
    }
    report["study_sha256"] = canonical_json_sha256({key: report[key] for key in (
        "plan_sha256", "profile", "model_config", "model_source_sha256", "trainer_source_sha256", "execution", "experiment",
        "optimizer", "curriculum_sha256", "evaluation")})
    report["planning_report_sha256"] = canonical_json_sha256(report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", default=str(DEFAULT_PLAN))
    parser.add_argument("--profile", choices=list(PROFILES), required=True)
    parser.add_argument("--out", help="optional JSON preparation report output")
    for name in PATH_FLAGS:
        parser.add_argument("--" + name.replace("_", "-"))
    args = parser.parse_args()
    supplied = {name: getattr(args, name) for name in PATH_FLAGS if getattr(args, name) is not None}
    try:
        report = build_planning_report(load_plan(args.plan), args.profile, supplied or None)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    if args.out:
        atomic_write_json(args.out, report)
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
