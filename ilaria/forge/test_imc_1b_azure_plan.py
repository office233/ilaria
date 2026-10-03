from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest

import imc_1b_azure_plan as planner
from data_contract import canonical_json_sha256, sha256_file
from imc_model import ImcConfig


def rehash(plan: dict) -> dict:
    plan["plan_sha256"] = planner.plan_identity(plan)
    return plan


@pytest.mark.parametrize("name,memory,context,micro,accum", [
    ("a100-40gb-2k", 40, 2048, 2, 16),
    ("a100-80gb-2k", 80, 2048, 8, 4),
    ("a100-40gb-4k-candidate", 40, 4096, 1, 16),
    ("a100-80gb-4k-candidate", 80, 4096, 4, 4),
])
def test_profiles_preserve_exact_horizon_and_native_model(name, memory, context, micro, accum):
    report = planner.build_planning_report(planner.load_plan(), name)
    assert report["profile"]["gpu_memory_gb"] == memory
    assert report["profile"]["context"] == context
    cfg = ImcConfig.from_json(report["model_config"])
    assert cfg.param_count() == planner.EXPECTED_PARAMS == 1_000_555_520
    assert (cfg.d_model, cfg.n_layers, cfg.n_heads, cfg.n_kv_heads, cfg.ffn_dim) == (2048, 16, 16, 4, 7104)
    assert (cfg.vocab_size, cfg.eos_token_id, cfg.max_seq_len, cfg.ternary) == (65536, 61440, context, True)
    assert report["execution"] == {
        "world_size": 8, "micro_batch": micro, "accum": accum, "steps": 38_147,
        "tokens_per_step": 524_288, "target_tokens": 20_000_000_000,
        "actual_tokens": 20_000_014_336, "overshoot_tokens": 14_336,
    }
    assert micro * context * accum * 8 == 524_288
    assert report["evaluation"]["validation_tokens_per_evaluation"] == micro * context * 64
    argv = report["command_argv_template"]
    assert argv[:4] == ["torchrun", "--standalone", "--nproc_per_node=8", "forge/train_ilaria.py"]
    assert argv[argv.index("--target-tokens") + 1] == "20000000000"
    assert argv[argv.index("--batch") + 1] == str(micro)
    assert argv[argv.index("--accum") + 1] == str(accum)
    assert argv[argv.index("--max-seq-len") + 1] == str(context)
    assert {"--ternary", "--chunked-loss", "--grad-checkpoint", "--dataset-manifest", "--tokenizer-freeze"} <= set(argv)
    assert not {"--allow-unmanifested-data", "--allow-internal-val-split", "--init-from", "--resume", "--compile"} & set(argv)


def test_curriculum_quotas_do_not_claim_future_dataset_or_unique_tokens():
    report = planner.build_planning_report(planner.load_plan(), "a100-40gb-2k")
    assert report["curriculum_sha256"] == planner.CURRICULUM_SHA256
    assert report["lane_token_budgets"] == {
        "general_knowledge": 6_000_000_000, "code": 4_400_000_000,
        "mathematics": 2_900_000_000, "science_technical_reasoning": 2_100_000_000,
        "os_hardware_drivers_standards": 2_000_000_000, "agent_tool_trajectories": 1_600_000_000,
        "romanian_multilingual": 0, "world_device_trajectories": 1_000_000_000,
    }
    assert sum(report["validation_lane_token_budgets"].values()) == 20_000_000
    assert report["required_dataset"] == {
        "minimum_train_tokens": 20_000_000_000, "minimum_validation_tokens": 20_000_000,
        "preserve_prior_holdouts": True, "token_budget_semantics": "processed_tokens_not_unique_source_tokens",
        "availability": "MISSING", "eligibility_verified": False,
    }
    assert report["missing_gates"] == planner.REQUIRED_GATES
    assert {"immutable_checkpoint_generations_restart", "azure_ddp_orchestration", "rank_local_cuda_rng_scope"} <= set(report["missing_gates"])
    assert report["status"] == "PREPARATION_ONLY"
    for field in ("launch_ready", "execution_authorized", "profile_fit_verified", "command_paths_verified", "cross_profile_exact_resume_allowed"):
        assert report[field] is False


def test_content_identities_are_stable_and_profiles_are_separate_studies():
    plan = planner.load_plan()
    assert plan["plan_sha256"] == planner.plan_identity(plan)
    reports = [planner.build_planning_report(plan, name) for name in planner.PROFILES]
    assert len({report["study_sha256"] for report in reports}) == 4
    assert reports[0] == planner.build_planning_report(plan, "a100-40gb-2k")
    for report in reports:
        assert report["planning_report_sha256"] == canonical_json_sha256({key: value for key, value in report.items() if key != "planning_report_sha256"})
        assert report["model_source_sha256"] == sha256_file(Path(planner.__file__).with_name("imc_model.py"))
        assert report["trainer_source_sha256"] == sha256_file(Path(planner.__file__).with_name("train_ilaria.py"))
    plan["experiment"]["seed"] += 1
    with pytest.raises(ValueError, match="content hash drifted"):
        planner.validate_plan(plan)
    report = planner.build_planning_report(rehash(plan), "a100-40gb-2k")
    assert report["study_sha256"] != reports[0]["study_sha256"]


@pytest.mark.parametrize("field,value", [
    ("world_size", 7), ("world_size", True), ("world_size", 8.0),
    ("target_tokens", 1_000_000_000), ("global_batch_tokens", 524_289),
    ("status", "READY"), ("format", "unversioned"), ("required_gates", []),
])
def test_rehashed_invalid_plan_cannot_become_eligible(field, value):
    plan = planner.load_plan()
    plan[field] = value
    with pytest.raises(ValueError):
        planner.validate_plan(rehash(plan))


@pytest.mark.parametrize("section,field,value", [
    ("model", "initialization", "pretrained"), ("model", "parameter_count", True),
    ("model", "preset", "imc-125m"), ("model", "eos_token_id", 61440.0),
    ("experiment", "name", "full_precision_control"), ("experiment", "ternary", 1),
    ("experiment", "seed", True), ("execution", "precision", "fp16"),
    ("execution", "chunked_loss", 1), ("execution", "compile", True),
    ("execution", "sample_tokens", False), ("evaluation", "every_steps", 0),
    ("evaluation", "iterations", 1.5), ("evaluation", "status", "FROZEN"),
    ("curriculum", "filename", "../../private.json"), ("curriculum", "identity_sha256", "0" * 64),
    ("required_dataset", "minimum_train_tokens", 19_999_999_999),
    ("required_dataset", "minimum_validation_tokens", 19_999_999),
    ("required_dataset", "preserve_prior_holdouts", False),
    ("required_dataset", "token_budget_semantics", "unique_tokens"),
    ("optimizer", "lr", float("nan")), ("optimizer", "lr", float("inf")),
    ("optimizer", "lr", True), ("optimizer", "lr", 0),
    ("optimizer", "min_lr", 1.0), ("optimizer", "weight_decay", -0.1),
    ("optimizer", "beta1", 1.0), ("optimizer", "beta2", -0.1),
    ("optimizer", "adam_eps", 0), ("optimizer", "grad_clip", float("inf")),
    ("optimizer", "grad_clip", 0),
    ("optimizer", "warmup_steps", 38_147), ("optimizer", "warmup_steps", True),
])
def test_operational_types_ranges_and_boundaries_are_fail_closed(section, field, value):
    plan = planner.load_plan()
    plan[section][field] = value
    with pytest.raises(ValueError):
        planner.validate_plan(rehash(plan))


@pytest.mark.parametrize("field,value", [
    ("micro_batch", 3), ("accum", 15), ("gpu_memory_gb", 80),
    ("context", 4096), ("max_seq_len", 4096), ("status", "BENCHMARKED"), ("role", "candidate"),
])
def test_profile_mutation_cannot_silently_change_a_study(field, value):
    plan = planner.load_plan()
    plan["profiles"][0][field] = value
    with pytest.raises(ValueError):
        planner.validate_plan(rehash(plan))


def test_valid_config_tuning_preserves_global_batch_with_new_identity():
    plan = planner.load_plan()
    original = planner.build_planning_report(plan, "a100-40gb-2k")
    plan["profiles"][0].update(micro_batch=4, accum=8)
    with pytest.raises(ValueError, match="content hash drifted"):
        planner.validate_plan(plan)
    report = planner.build_planning_report(rehash(plan), "a100-40gb-2k")
    assert report["execution"]["micro_batch"] == 4 and report["execution"]["accum"] == 8
    assert report["execution"]["tokens_per_step"] == 524_288
    assert report["study_sha256"] != original["study_sha256"]
    assert report["profile_fit_verified"] is False and report["launch_ready"] is False


def test_matched_full_precision_control_requires_consistent_explicit_plan():
    plan = planner.load_plan()
    ternary = planner.build_planning_report(plan, "a100-80gb-2k")
    plan["experiment"].update(name="full_precision_control", ternary=False)
    with pytest.raises(ValueError, match="ineligible experiment"):
        planner.validate_plan(rehash(plan))
    plan["model"]["weight_mode"] = "full_precision"
    control = planner.build_planning_report(rehash(plan), "a100-80gb-2k")
    assert "--ternary" not in control["command_argv_template"]
    assert control["model_config"]["ternary"] is False
    assert ImcConfig.from_json(control["model_config"]).param_count() == planner.EXPECTED_PARAMS
    assert control["study_sha256"] != ternary["study_sha256"]
    for field in ("execution", "optimizer", "curriculum_sha256", "evaluation"):
        assert control[field] == ternary[field]
    assert control["launch_ready"] is control["execution_authorized"] is False


def test_unknown_fields_duplicate_profile_and_invalid_profile_selection_fail():
    plan = planner.load_plan()
    plan["allow_unmanifested_data"] = True
    with pytest.raises(ValueError, match="fields mismatch"):
        planner.validate_plan(rehash(plan))
    plan = planner.load_plan()
    plan["profiles"][1] = copy.deepcopy(plan["profiles"][0])
    with pytest.raises(ValueError, match="repeated profile"):
        planner.validate_plan(rehash(plan))
    with pytest.raises(ValueError, match="unknown profile"):
        planner.build_planning_report(planner.load_plan(), "single-gpu-colab")


def test_explicit_nonexistent_paths_remain_unverified_and_no_execution_occurs(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("planner must not execute, probe CUDA or allocate model weights")
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    import torch
    import imc_model
    monkeypatch.setattr(torch.cuda, "is_available", forbidden)
    monkeypatch.setattr(imc_model, "ImcTransformer", forbidden)
    paths = {name: "/required-new-production/" + name for name in planner.PATH_FLAGS}
    report = planner.build_planning_report(planner.load_plan(), "a100-80gb-2k", paths)
    assert report["launch_ready"] is report["execution_authorized"] is report["command_paths_verified"] is False
    assert "first_party_contracts=" + paths["first_party_contracts"] in report["command_argv_template"]
    with pytest.raises(ValueError, match="all-or-none"):
        planner.build_planning_report(planner.load_plan(), "a100-40gb-2k", {"train_data": "x"})
    paths["train_data"] = "invalid\npath"
    with pytest.raises(ValueError, match="single-line"):
        planner.build_planning_report(planner.load_plan(), "a100-40gb-2k", paths)


@pytest.mark.parametrize("ternary", [True, False])
def test_template_passes_actual_trainer_parser_and_argument_contract_without_training(monkeypatch, ternary):
    import train_ilaria as trainer
    plan = planner.load_plan()
    if not ternary:
        plan["model"]["weight_mode"] = "full_precision"
        plan["experiment"].update(name="full_precision_control", ternary=False)
        rehash(plan)
    report = planner.build_planning_report(plan, "a100-40gb-2k")
    original = trainer.validate_training_args

    class ValidatedOnly(RuntimeError):
        pass

    def validate_only(args):
        original(args)
        assert args.preset == "imc-1b" and args.ternary is ternary
        assert (args.ctx, args.batch, args.accum, args.target_tokens) == (2048, 2, 16, 20_000_000_000)
        assert args.precision == "bf16" and args.chunked_loss and args.grad_checkpoint
        assert args.dataset_manifest and args.tokenizer_freeze and args.val_data
        assert not args.resume and not args.init_from and not args.allow_unmanifested_data
        raise ValidatedOnly("stop before data or CUDA")

    monkeypatch.setattr(trainer, "validate_training_args", validate_only)
    monkeypatch.setattr(sys, "argv", ["train_ilaria.py", *report["command_argv_template"][4:]])
    with pytest.raises(ValidatedOnly, match="stop before data or CUDA"):
        trainer.main()


def test_cli_writes_only_preparation_report_and_rejects_partial_paths(tmp_path):
    destination = tmp_path / "report.json"
    command = [sys.executable, str(Path(planner.__file__)), "--profile", "a100-40gb-2k", "--out", str(destination)]
    run = subprocess.run(command, text=True, capture_output=True, check=True)
    report = json.loads(run.stdout)
    assert json.loads(destination.read_text(encoding="utf-8")) == report
    assert report["status"] == "PREPARATION_ONLY" and report["execution_authorized"] is False
    rejected = subprocess.run(command + ["--train-data", "/only/one/path"], text=True, capture_output=True)
    assert rejected.returncode == 2 and "all-or-none" in rejected.stderr
    assert json.loads(destination.read_text(encoding="utf-8")) == report
