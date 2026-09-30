from __future__ import annotations

import copy

import pytest

from imc_125m_launch import build_launch_manifest, validate_launch_manifest


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
            "lr": 0.0006,
            "min_lr": 0.00006,
            "warmup_steps": 200,
            "weight_decay": 0.1,
            "beta1": 0.9,
            "beta2": 0.95,
            "adam_eps": 1e-8,
            "grad_clip": 1.0,
            "lr_schedule": "cosine",
        },
        "execution": {
            "chunked_loss": True,
            "grad_checkpoint": True,
            "precision": "auto",
        },
        "experiments": [
            {"name": "ternary_candidate", "ternary": True, "seeds": [7, 11, 19]},
            {"name": "full_precision_control", "ternary": False, "seeds": [7, 11, 19]},
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


def paths():
    return {
        "train_data": "/data/train",
        "validation_data": "/data/validation",
        "dataset_manifest": "/data/dataset.manifest.json",
        "tokenizer_freeze": "/data/ilarialex.freeze.json",
        "tokenizer": "/data/ilarialex.json",
        "output_dir": "/runs/imc125-seed7",
    }


def test_single_gpu_ternary_launch_is_exact_and_content_addressed():
    manifest = build_launch_manifest(
        recipe(), readiness(),
        experiment_name="ternary_candidate",
        seed=7,
        world_size=1,
        micro_batch=4,
        paths=paths(),
    )
    assert validate_launch_manifest(manifest) == manifest
    assert manifest["execution"]["accum"] == 32
    assert manifest["execution"]["steps"] == 3815
    assert manifest["command_argv"][:2] == ["python", "forge/train_ilaria.py"]
    assert "--ternary" in manifest["command_argv"]
    assert "--target-tokens" in manifest["command_argv"]
    assert len(manifest["launch_sha256"]) == 64


def test_multi_gpu_control_launch_uses_torchrun_without_ternary():
    manifest = build_launch_manifest(
        recipe(), readiness(),
        experiment_name="full_precision_control",
        seed=11,
        world_size=8,
        micro_batch=4,
        paths=paths(),
    )
    assert manifest["execution"]["accum"] == 4
    assert manifest["command_argv"][:3] == [
        "torchrun", "--standalone", "--nproc_per_node=8"
    ]
    assert "--ternary" not in manifest["command_argv"]


def test_launch_rejects_seed_outside_locked_experiment():
    with pytest.raises(ValueError, match="not locked"):
        build_launch_manifest(
            recipe(), readiness(),
            experiment_name="ternary_candidate",
            seed=23,
            world_size=1,
            micro_batch=4,
            paths=paths(),
        )


def test_launch_rejects_failed_preflight():
    failed = readiness()
    failed["ready"] = False
    with pytest.raises(ValueError, match="passing preflight"):
        build_launch_manifest(
            recipe(), failed,
            experiment_name="ternary_candidate",
            seed=7,
            world_size=1,
            micro_batch=4,
            paths=paths(),
        )


def test_launch_rejects_curriculum_drift():
    drifted = readiness()
    drifted["curriculum_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="curriculum differs"):
        build_launch_manifest(
            recipe(), drifted,
            experiment_name="ternary_candidate",
            seed=7,
            world_size=1,
            micro_batch=4,
            paths=paths(),
        )


def test_launch_manifest_detects_tampering():
    manifest = build_launch_manifest(
        recipe(), readiness(),
        experiment_name="ternary_candidate",
        seed=7,
        world_size=1,
        micro_batch=4,
        paths=paths(),
    )
    tampered = copy.deepcopy(manifest)
    tampered["execution"]["target_tokens"] = 999
    with pytest.raises(ValueError, match="identity hash mismatch"):
        validate_launch_manifest(tampered)


def test_resume_launch_pins_checkpoint_hash_and_pause_without_changing_horizon():
    manifest = build_launch_manifest(
        recipe(), readiness(),
        experiment_name="ternary_candidate",
        seed=7,
        world_size=1,
        micro_batch=4,
        paths=paths(),
        resume_checkpoint={"path": "/runs/checkpoint.pt", "sha256": "1" * 64},
        stop_after=25,
        sample_tokens=0,
    )
    assert manifest["resume_checkpoint"] == {
        "path": "/runs/checkpoint.pt",
        "sha256": "1" * 64,
    }
    assert manifest["execution"]["target_tokens"] == 1_000_000_000
    assert manifest["execution"]["stop_after"] == 25
    assert manifest["execution"]["sample_tokens"] == 0
    argv = manifest["command_argv"]
    assert argv[argv.index("--sample-tokens") + 1] == "0"
    assert argv[argv.index("--resume") + 1] == "/runs/checkpoint.pt"
    assert argv[argv.index("--stop-after") + 1] == "25"


def test_resume_launch_rejects_unpinned_checkpoint():
    with pytest.raises(ValueError, match="path and sha256"):
        build_launch_manifest(
            recipe(), readiness(),
            experiment_name="ternary_candidate",
            seed=7,
            world_size=1,
            micro_batch=4,
            paths=paths(),
            resume_checkpoint={"path": "/runs/checkpoint.pt"},
        )
