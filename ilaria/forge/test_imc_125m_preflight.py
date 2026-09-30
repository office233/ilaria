from __future__ import annotations

from pathlib import Path

from curriculum_stream import load_curriculum
from imc_125m_preflight import (
    IMC_125M_EXPECTED_PARAMS,
    build_readiness_report,
)


def manifests(*, train_tokens: int = 1_000_000_000):
    tokenizer_sha = "a" * 64
    rights_sha = "b" * 64
    curriculum = load_curriculum(
        Path(__file__).resolve().parent / "config" / "imc_125m_curriculum.json"
    )

    def curriculum_record(tokens):
        return {
            "format": "ilaria-curriculum-stream-v1",
            "config_identity_sha256": curriculum["curriculum_sha256"],
            "target_tokens": tokens,
            "lanes": [
                {
                    "lane": lane,
                    "target_ppm": ppm,
                    "tokens": tokens * ppm // 1_000_000,
                }
                for lane, ppm in sorted(curriculum["target_mix_ppm"].items())
            ],
        }

    freeze = {
        "freeze_sha256": "c" * 64,
        "sample": {"source_lock": {"identity_sha256": "e" * 64}},
        "tokenizer": {
            "sha256": tokenizer_sha,
            "vocab_size": 65_536,
            "eos_id": 61_440,
            "protocol_start_id": 61_440,
        },
        "rights": {"sha256": rights_sha},
    }
    dataset = {
        "dataset_manifest_sha256": "d" * 64,
        "tokenizer": {
            "sha256": tokenizer_sha,
            "vocab_size": 65_536,
            "eos_id": 61_440,
            "protocol_start_id": 61_440,
        },
        "rights": {"sha256": rights_sha},
        "streams": {
            "train": {
                "tokens": train_tokens,
                "curriculum": curriculum_record(train_tokens),
            },
            "validation": {
                "tokens": 100_000,
                "curriculum": curriculum_record(100_000),
            },
        },
    }
    return freeze, dataset


def test_preflight_accepts_exact_imc_125m_contract():
    freeze, dataset = manifests()
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is True
    assert report["parameter_count"] == IMC_125M_EXPECTED_PARAMS == 125_882_112
    assert not report["failed_checks"]


def test_preflight_rejects_smoke_corpus_as_serious_run():
    freeze, dataset = manifests(train_tokens=10_000_000)
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["train_token_budget"] is False
    assert "train_token_budget" in report["failed_checks"]


def test_preflight_rejects_tokenizer_identity_drift():
    freeze, dataset = manifests()
    dataset["tokenizer"]["sha256"] = "e" * 64
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["tokenizer_sha256_match"] is False


def test_preflight_rejects_rights_registry_drift():
    freeze, dataset = manifests()
    dataset["rights"]["sha256"] = "f" * 64
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["rights_registry_match"] is False


def test_preflight_rejects_protocol_identity_drift():
    freeze, dataset = manifests()
    dataset["tokenizer"]["protocol_start_id"] = 61_439
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["protocol_start_id_match"] is False


def test_preflight_accepts_git_only_source_lock():
    freeze, dataset = manifests()
    freeze["sample"] = {"git_source_lock": {"identity_sha256": "f" * 64}}
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is True
    assert report["checks"]["source_lock_pinned"] is True


def test_preflight_rejects_unpinned_sources():
    freeze, dataset = manifests()
    freeze["sample"] = {}
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["source_lock_pinned"] is False


def test_preflight_rejects_unlocked_tokenizer_sample():
    freeze, dataset = manifests()
    del freeze["sample"]["source_lock"]
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["source_lock_pinned"] is False


def test_preflight_rejects_missing_curriculum():
    freeze, dataset = manifests()
    del dataset["streams"]["train"]["curriculum"]
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["train_curriculum_pinned"] is False
    assert report["checks"]["curriculum_identity_match"] is False


def test_preflight_rejects_curriculum_weight_drift():
    freeze, dataset = manifests()
    lanes = dataset["streams"]["train"]["curriculum"]["lanes"]
    lanes[0]["target_ppm"] += 1
    report = build_readiness_report(freeze, dataset)
    assert report["ready"] is False
    assert report["checks"]["curriculum_mix_match"] is False
