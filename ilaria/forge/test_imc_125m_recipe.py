from __future__ import annotations

from pathlib import Path

import pytest

from imc_125m_recipe import EXPECTED_PARAMS, load_recipe, resolve_execution


RECIPE = Path(__file__).resolve().parent / "config" / "imc_125m_recipe.json"


def test_canonical_recipe_is_valid_and_exact():
    recipe = load_recipe(RECIPE)
    assert recipe["parameter_count"] == EXPECTED_PARAMS == 125_882_112
    assert recipe["target_tokens"] == 1_000_000_000
    assert len(recipe["recipe_file_sha256"]) == 64
    assert recipe["curriculum_resolved"]["identity_sha256"] == (
        "3ac9c6e0a36e85151e543dfbff09c8ea319b1566b6dd77d981cab8c8f34a4432"
    )
    assert sum(recipe["curriculum_resolved"]["target_mix_ppm"].values()) == 1_000_000


def test_single_worker_execution_preserves_global_batch():
    report = resolve_execution(load_recipe(RECIPE), world_size=1, micro_batch=4)
    assert report["accum"] == 32
    assert report["steps"] == 3815
    assert report["tokens_per_step"] == 262_144


def test_multi_worker_execution_preserves_global_batch():
    report = resolve_execution(load_recipe(RECIPE), world_size=8, micro_batch=4)
    assert report["accum"] == 4
    assert report["steps"] == 3815


def test_unrepresentable_hardware_batch_fails_closed():
    with pytest.raises(ValueError, match="cannot realize"):
        resolve_execution(load_recipe(RECIPE), world_size=3, micro_batch=5)
