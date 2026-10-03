"""Content-addressed launch manifests for reproducible IMC-125M bootstrap runs."""
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from .data_contract import (
        atomic_write_json,
        canonical_json_sha256,
        require_lower_sha256,
        sha256_file,
    )
    from .imc_125m_preflight import validate_imc_125m_readiness
    from .imc_125m_recipe import load_recipe, resolve_execution
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, canonical_json_sha256, require_lower_sha256, sha256_file
    from imc_125m_preflight import validate_imc_125m_readiness
    from imc_125m_recipe import load_recipe, resolve_execution

LAUNCH_FORMAT = "imc-125m-launch-v1"


def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("launch_sha256", None)
    return canonical_json_sha256(payload)


def _require_nonempty_paths(paths: dict[str, str]) -> dict[str, str]:
    required = {
        "train_data",
        "validation_data",
        "dataset_manifest",
        "tokenizer_freeze",
        "tokenizer",
        "output_dir",
    }
    if set(paths) != required:
        missing = sorted(required - set(paths))
        extra = sorted(set(paths) - required)
        raise ValueError(f"launch paths mismatch: missing={missing}, extra={extra}")
    normalized = {}
    for name in sorted(required):
        value = paths[name]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"launch path {name!r} is empty")
        normalized[name] = value
    return normalized


def build_launch_manifest(
    recipe: dict,
    readiness: dict,
    *,
    experiment_name: str,
    seed: int,
    world_size: int,
    micro_batch: int,
    paths: dict[str, str],
    eval_every: int = 250,
    eval_iters: int = 20,
    compile_model: bool = False,
    resume_checkpoint: dict[str, str] | None = None,
    stop_after: int = 0,
    sample_tokens: int = 30,
) -> dict:
    """Build a launch contract from already-validated recipe/readiness objects."""
    if readiness.get("ready") is not True:
        raise ValueError("IMC-125M launch requires a passing preflight")
    if type(seed) is not int or seed < 0:
        raise ValueError("launch seed must be a non-negative integer")
    if type(eval_every) is not int or eval_every < 1:
        raise ValueError("launch eval_every must be positive")
    if type(eval_iters) is not int or eval_iters < 1:
        raise ValueError("launch eval_iters must be positive")
    if type(compile_model) is not bool:
        raise ValueError("launch compile_model must be boolean")
    if type(stop_after) is not int or stop_after < 0:
        raise ValueError("launch stop_after must be a non-negative integer")
    if type(sample_tokens) is not int or sample_tokens < 0:
        raise ValueError("launch sample_tokens must be a non-negative integer")
    normalized_resume = None
    if resume_checkpoint is not None:
        if not isinstance(resume_checkpoint, dict) or set(resume_checkpoint) != {"path", "sha256"}:
            raise ValueError("resume checkpoint requires exactly path and sha256")
        resume_path = resume_checkpoint.get("path")
        resume_sha256 = resume_checkpoint.get("sha256")
        if not isinstance(resume_path, str) or not resume_path.strip():
            raise ValueError("resume checkpoint path is empty")
        require_lower_sha256("resume checkpoint sha256", str(resume_sha256 or ""))
        normalized_resume = {"path": resume_path, "sha256": resume_sha256}

    experiments = {
        item.get("name"): item
        for item in recipe.get("experiments", [])
        if isinstance(item, dict)
    }
    experiment = experiments.get(experiment_name)
    if experiment is None:
        raise ValueError(f"unknown IMC-125M experiment {experiment_name!r}")
    if seed not in experiment.get("seeds", []):
        raise ValueError(
            f"seed {seed} is not locked for experiment {experiment_name!r}"
        )

    recipe_curriculum = recipe.get("curriculum_resolved")
    if not isinstance(recipe_curriculum, dict):
        raise ValueError("IMC-125M recipe has no resolved curriculum identity")
    if recipe_curriculum.get("identity_sha256") != readiness.get("curriculum_sha256"):
        raise ValueError("IMC-125M launch curriculum differs from preflight dataset")

    execution = resolve_execution(
        recipe,
        world_size=world_size,
        micro_batch=micro_batch,
    )
    normalized_paths = _require_nonempty_paths(paths)
    optimizer = recipe["optimizer"]
    execution_policy = recipe["execution"]

    trainer_argv = [
        "forge/train_ilaria.py",
        "--data", normalized_paths["train_data"],
        "--val-data", normalized_paths["validation_data"],
        "--out", normalized_paths["output_dir"],
        "--tokenizer", normalized_paths["tokenizer"],
        "--dataset-manifest", normalized_paths["dataset_manifest"],
        "--tokenizer-freeze", normalized_paths["tokenizer_freeze"],
        "--preset", recipe["preset"],
        "--ctx", str(recipe["context"]),
        "--max-seq-len", str(recipe["max_seq_len"]),
        "--batch", str(micro_batch),
        "--accum", str(execution["accum"]),
        "--target-tokens", str(recipe["target_tokens"]),
        "--warmup", str(optimizer["warmup_steps"]),
        "--lr", str(optimizer["lr"]),
        "--min-lr", str(optimizer["min_lr"]),
        "--lr-schedule", optimizer["lr_schedule"],
        "--wd", str(optimizer["weight_decay"]),
        "--beta1", str(optimizer["beta1"]),
        "--beta2", str(optimizer["beta2"]),
        "--adam-eps", str(optimizer["adam_eps"]),
        "--grad-clip", str(optimizer["grad_clip"]),
        "--eval-every", str(eval_every),
        "--eval-iters", str(eval_iters),
        "--seed", str(seed),
        "--precision", execution_policy["precision"],
        "--sample-tokens", str(sample_tokens),
    ]
    if execution_policy.get("chunked_loss") is True:
        trainer_argv.append("--chunked-loss")
    if execution_policy.get("grad_checkpoint") is True:
        trainer_argv.append("--grad-checkpoint")
    if experiment.get("ternary") is True:
        trainer_argv.append("--ternary")
    if compile_model:
        trainer_argv.append("--compile")
    if normalized_resume is not None:
        trainer_argv.extend(["--resume", normalized_resume["path"]])
    if stop_after:
        trainer_argv.extend(["--stop-after", str(stop_after)])

    if world_size == 1:
        command_argv = ["python", *trainer_argv]
    else:
        command_argv = [
            "torchrun",
            "--standalone",
            f"--nproc_per_node={world_size}",
            *trainer_argv,
        ]

    manifest = {
        "format": LAUNCH_FORMAT,
        "recipe_sha256": recipe["recipe_file_sha256"],
        "experiment": {
            "name": experiment_name,
            "ternary": bool(experiment["ternary"]),
            "seed": seed,
        },
        "artifacts": {
            "dataset_manifest_sha256": readiness["dataset_manifest_sha256"],
            "tokenizer_freeze_sha256": readiness["freeze_sha256"],
            "tokenizer_sha256": readiness["tokenizer_sha256"],
            "curriculum_sha256": readiness["curriculum_sha256"],
        },
        "model": {
            "preset": recipe["preset"],
            "parameter_count": readiness["parameter_count"],
            "vocab_size": recipe["vocab_size"],
            "context": recipe["context"],
        },
        "execution": {
            **execution,
            "precision": execution_policy["precision"],
            "chunked_loss": bool(execution_policy.get("chunked_loss")),
            "grad_checkpoint": bool(execution_policy.get("grad_checkpoint")),
            "compile": compile_model,
            "eval_every": eval_every,
            "eval_iters": eval_iters,
            "stop_after": stop_after,
            "sample_tokens": sample_tokens,
        },
        **({"resume_checkpoint": normalized_resume} if normalized_resume is not None else {}),
        "curriculum_mix_ppm": dict(recipe_curriculum["target_mix_ppm"]),
        "paths": normalized_paths,
        "command_argv": command_argv,
        "required_evaluations": list(recipe["required_evaluations"]),
    }
    manifest["launch_sha256"] = _identity_hash(manifest)
    return manifest


def validate_launch_manifest(manifest: dict) -> dict:
    if not isinstance(manifest, dict) or manifest.get("format") != LAUNCH_FORMAT:
        raise ValueError("unsupported IMC-125M launch manifest format")
    declared = manifest.get("launch_sha256")
    if not isinstance(declared, str) or _identity_hash(manifest) != declared:
        raise ValueError("IMC-125M launch manifest identity hash mismatch")
    command = manifest.get("command_argv")
    if not isinstance(command, list) or not command or not all(
        isinstance(item, str) and item for item in command
    ):
        raise ValueError("IMC-125M launch command is invalid")
    if manifest.get("model", {}).get("parameter_count") != 125_882_112:
        raise ValueError("IMC-125M launch parameter count drifted")
    if manifest.get("execution", {}).get("target_tokens") != 1_000_000_000:
        raise ValueError("IMC-125M launch token horizon drifted")
    return manifest


def main() -> None:
    config = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", default=str(config / "imc_125m_recipe.json"))
    parser.add_argument("--freeze", required=True)
    parser.add_argument("--dataset-manifest", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--train-data", required=True)
    parser.add_argument("--validation-data", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--world-size", type=int, required=True)
    parser.add_argument("--micro-batch", type=int, required=True)
    parser.add_argument("--eval-every", type=int, default=250)
    parser.add_argument("--eval-iters", type=int, default=20)
    parser.add_argument("--compile", action="store_true")
    parser.add_argument("--resume", default="")
    parser.add_argument("--stop-after", type=int, default=0)
    parser.add_argument("--sample-tokens", type=int, default=30)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    recipe = load_recipe(args.recipe)
    readiness = validate_imc_125m_readiness(
        args.freeze,
        args.dataset_manifest,
        rights_registry_path=args.rights,
    )
    resume_checkpoint = None
    if args.resume:
        resume_path = Path(args.resume)
        if not resume_path.is_file():
            raise ValueError(f"resume checkpoint does not exist: {resume_path}")
        resume_checkpoint = {
            "path": args.resume,
            "sha256": sha256_file(resume_path),
        }
    manifest = build_launch_manifest(
        recipe,
        readiness,
        experiment_name=args.experiment,
        seed=args.seed,
        world_size=args.world_size,
        micro_batch=args.micro_batch,
        paths={
            "train_data": args.train_data,
            "validation_data": args.validation_data,
            "dataset_manifest": args.dataset_manifest,
            "tokenizer_freeze": args.freeze,
            "tokenizer": args.tokenizer,
            "output_dir": args.output_dir,
        },
        eval_every=args.eval_every,
        eval_iters=args.eval_iters,
        compile_model=args.compile,
        resume_checkpoint=resume_checkpoint,
        stop_after=args.stop_after,
        sample_tokens=args.sample_tokens,
    )
    validate_launch_manifest(manifest)
    atomic_write_json(args.out, manifest)
    print(f"[imc-125m-launch] {args.out}: {manifest['launch_sha256']}")


if __name__ == "__main__":
    main()
