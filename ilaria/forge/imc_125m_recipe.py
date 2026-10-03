"""Validate and resolve the hardware-independent IMC-125M bootstrap recipe."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from curriculum_stream import load_curriculum
from imc_model import ImcConfig

RECIPE_FORMAT = "imc-125m-recipe-v1"
EXPECTED_PARAMS = 125_882_112


def load_recipe(path: str | Path) -> dict:
    recipe_path = Path(path)
    raw = recipe_path.read_bytes()
    recipe = json.loads(raw)
    if not isinstance(recipe, dict) or recipe.get("format") != RECIPE_FORMAT:
        raise ValueError("unsupported IMC-125M recipe format")
    if recipe.get("status") != "BOOTSTRAP_NOT_PROMOTED":
        raise ValueError("IMC-125M recipe status must remain BOOTSTRAP_NOT_PROMOTED")
    if recipe.get("preset") != "imc-125m":
        raise ValueError("IMC-125M recipe uses the wrong preset")
    if recipe.get("vocab_size") != 65_536:
        raise ValueError("IMC-125M recipe requires the canonical 65,536 vocabulary")
    if recipe.get("context") != 2_048 or recipe.get("max_seq_len") != 2_048:
        raise ValueError("IMC-125M recipe requires context/max_seq_len 2048")
    if recipe.get("target_tokens") != 1_000_000_000:
        raise ValueError("IMC-125M bootstrap recipe requires exactly 1B target tokens")
    global_batch_tokens = recipe.get("global_batch_tokens")
    if type(global_batch_tokens) is not int or global_batch_tokens < 2_048:
        raise ValueError("IMC-125M recipe global_batch_tokens is invalid")
    if global_batch_tokens % 2_048:
        raise ValueError("global_batch_tokens must be an exact number of sequences")

    curriculum_ref = recipe.get("curriculum")
    if not isinstance(curriculum_ref, dict):
        raise ValueError("IMC-125M recipe has no curriculum identity")
    curriculum_filename = curriculum_ref.get("filename")
    if not isinstance(curriculum_filename, str) or not curriculum_filename:
        raise ValueError("IMC-125M recipe curriculum filename is invalid")
    curriculum = load_curriculum(recipe_path.parent / curriculum_filename)
    if curriculum_ref.get("identity_sha256") != curriculum["curriculum_sha256"]:
        raise ValueError("IMC-125M recipe curriculum identity drifted")

    cfg = ImcConfig.preset(
        "imc-125m",
        vocab_size=65_536,
        eos_token_id=61_440,
        max_seq_len=2_048,
        ternary=True,
    )
    if cfg.param_count() != EXPECTED_PARAMS or recipe.get("parameter_count") != EXPECTED_PARAMS:
        raise ValueError("IMC-125M recipe parameter count drifted")

    experiments = recipe.get("experiments")
    if not isinstance(experiments, list) or len(experiments) != 2:
        raise ValueError("IMC-125M recipe requires ternary and full-precision experiments")
    by_name = {item.get("name"): item for item in experiments if isinstance(item, dict)}
    for name, ternary in (("ternary_candidate", True), ("full_precision_control", False)):
        item = by_name.get(name)
        if not item or item.get("ternary") is not ternary:
            raise ValueError(f"IMC-125M recipe experiment {name!r} is invalid")
        seeds = item.get("seeds")
        if not isinstance(seeds, list) or len(seeds) < 3 or len(set(seeds)) != len(seeds):
            raise ValueError(f"IMC-125M recipe experiment {name!r} needs >=3 unique seeds")
        if any(type(seed) is not int or seed < 0 for seed in seeds):
            raise ValueError(f"IMC-125M recipe experiment {name!r} has invalid seeds")
    recipe["recipe_file_sha256"] = hashlib.sha256(raw).hexdigest()
    recipe["curriculum_resolved"] = {
        "identity_sha256": curriculum["curriculum_sha256"],
        "target_mix_ppm": dict(curriculum["target_mix_ppm"]),
    }
    return recipe


def resolve_execution(
    recipe: dict,
    *,
    world_size: int,
    micro_batch: int,
) -> dict:
    for name, value in {"world_size": world_size, "micro_batch": micro_batch}.items():
        if type(value) is not int or value < 1:
            raise ValueError(f"{name} must be a positive integer")
    ctx = int(recipe["context"])
    target_global = int(recipe["global_batch_tokens"])
    denominator = ctx * micro_batch * world_size
    if target_global % denominator:
        raise ValueError(
            "micro_batch/world_size cannot realize the locked global batch exactly"
        )
    accum = target_global // denominator
    steps = math.ceil(int(recipe["target_tokens"]) / target_global)
    actual_tokens = steps * target_global
    return {
        "world_size": world_size,
        "micro_batch": micro_batch,
        "accum": accum,
        "steps": steps,
        "tokens_per_step": target_global,
        "target_tokens": int(recipe["target_tokens"]),
        "actual_tokens": actual_tokens,
        "overshoot_tokens": actual_tokens - int(recipe["target_tokens"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--recipe",
        default=str(Path(__file__).resolve().parent / "config" / "imc_125m_recipe.json"),
    )
    parser.add_argument("--world-size", type=int, required=True)
    parser.add_argument("--micro-batch", type=int, required=True)
    args = parser.parse_args()
    recipe = load_recipe(args.recipe)
    report = resolve_execution(
        recipe,
        world_size=args.world_size,
        micro_batch=args.micro_batch,
    )
    print(json.dumps({"recipe": recipe, "execution": report}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
