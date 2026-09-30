"""Fail-closed readiness gate for the first serious IMC-125M run."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from curriculum_stream import REQUIRED_LANES, load_curriculum
from dataset_manifest import validate_dataset_manifest_file
from imc_model import ImcConfig
from tokenizer_freeze import validate_freeze_manifest

IMC_125M_PRESET = "imc-125m"
IMC_125M_EXPECTED_PARAMS = 125_882_112
DEFAULT_MIN_TRAIN_TOKENS = 1_000_000_000
DEFAULT_MIN_VALIDATION_TOKENS = 2_049
CANONICAL_CONTEXT = 2_048
CANONICAL_CURRICULUM = (
    Path(__file__).resolve().parent / "config" / "imc_125m_curriculum.json"
)


def _require_int(name: str, value: object, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def build_readiness_report(
    freeze: dict,
    dataset: dict,
    *,
    min_train_tokens: int = DEFAULT_MIN_TRAIN_TOKENS,
    min_validation_tokens: int = DEFAULT_MIN_VALIDATION_TOKENS,
) -> dict:
    _require_int("min_train_tokens", min_train_tokens, minimum=1)
    _require_int("min_validation_tokens", min_validation_tokens, minimum=1)

    try:
        ft = freeze["tokenizer"]
        fr = freeze["rights"]
        sample = freeze["sample"]
        dt = dataset["tokenizer"]
        dr = dataset["rights"]
        train = dataset["streams"]["train"]
        val = dataset["streams"]["validation"]
    except (KeyError, TypeError) as exc:
        raise ValueError("IMC-125M preflight input manifests are incomplete") from exc

    vocab = _require_int("tokenizer vocab_size", ft.get("vocab_size"), minimum=1)
    eos = _require_int("tokenizer eos_id", ft.get("eos_id"))
    protocol_start = _require_int(
        "tokenizer protocol_start_id", ft.get("protocol_start_id")
    )
    train_tokens = _require_int("train tokens", train.get("tokens"), minimum=1)
    val_tokens = _require_int("validation tokens", val.get("tokens"), minimum=1)
    curriculum = load_curriculum(CANONICAL_CURRICULUM)
    train_curriculum = train.get("curriculum")
    validation_curriculum = val.get("curriculum")

    def curriculum_mix(value: object) -> dict[str, int] | None:
        if not isinstance(value, dict):
            return None
        lanes = value.get("lanes")
        if not isinstance(lanes, list) or len(lanes) != len(REQUIRED_LANES):
            return None
        observed = {}
        for record in lanes:
            if not isinstance(record, dict):
                return None
            lane = record.get("lane")
            ppm = record.get("target_ppm")
            if lane in observed or lane not in REQUIRED_LANES or type(ppm) is not int:
                return None
            observed[lane] = ppm
        return observed if set(observed) == REQUIRED_LANES else None

    train_mix = curriculum_mix(train_curriculum)
    validation_mix = curriculum_mix(validation_curriculum)
    expected_mix = curriculum["target_mix_ppm"]

    cfg = ImcConfig.preset(
        IMC_125M_PRESET,
        vocab_size=vocab,
        eos_token_id=eos,
        max_seq_len=CANONICAL_CONTEXT,
        ternary=True,
    )
    parameter_count = cfg.param_count()

    checks = {
        "tokenizer_sha256_match": ft.get("sha256") == dt.get("sha256"),
        "vocab_size_match": vocab == dt.get("vocab_size"),
        "eos_id_match": eos == dt.get("eos_id"),
        "protocol_start_id_match": protocol_start == dt.get("protocol_start_id"),
        "rights_registry_match": fr.get("sha256") == dr.get("sha256"),
        "source_lock_pinned": any(
            isinstance(sample.get(key), dict)
            for key in ("source_lock", "git_source_lock")
        ),
        "train_curriculum_pinned": isinstance(train_curriculum, dict),
        "validation_curriculum_pinned": isinstance(validation_curriculum, dict),
        "curriculum_identity_match": (
            isinstance(train_curriculum, dict)
            and isinstance(validation_curriculum, dict)
            and train_curriculum.get("config_identity_sha256")
            == curriculum["curriculum_sha256"]
            and validation_curriculum.get("config_identity_sha256")
            == curriculum["curriculum_sha256"]
        ),
        "curriculum_mix_match": train_mix == expected_mix and validation_mix == expected_mix,
        "curriculum_token_accounting": (
            isinstance(train_curriculum, dict)
            and isinstance(validation_curriculum, dict)
            and train_curriculum.get("target_tokens") == train_tokens
            and validation_curriculum.get("target_tokens") == val_tokens
        ),
        "parameter_count_exact": parameter_count == IMC_125M_EXPECTED_PARAMS,
        "train_token_budget": train_tokens >= min_train_tokens,
        "validation_token_budget": val_tokens >= min_validation_tokens,
    }
    failed = sorted(name for name, passed in checks.items() if not passed)
    return {
        "format": "imc-125m-preflight-v1",
        "ready": not failed,
        "failed_checks": failed,
        "checks": checks,
        "preset": IMC_125M_PRESET,
        "parameter_count": parameter_count,
        "expected_parameter_count": IMC_125M_EXPECTED_PARAMS,
        "context": CANONICAL_CONTEXT,
        "train_tokens": train_tokens,
        "validation_tokens": val_tokens,
        "min_train_tokens": min_train_tokens,
        "min_validation_tokens": min_validation_tokens,
        "tokenizer_sha256": ft.get("sha256"),
        "freeze_sha256": freeze.get("freeze_sha256"),
        "dataset_manifest_sha256": dataset.get("dataset_manifest_sha256"),
        "curriculum_sha256": curriculum["curriculum_sha256"],
        "curriculum_mix_ppm": dict(expected_mix),
    }


def validate_imc_125m_readiness(
    freeze_path: str | Path,
    dataset_manifest_path: str | Path,
    *,
    rights_registry_path: str | Path,
    min_train_tokens: int = DEFAULT_MIN_TRAIN_TOKENS,
    min_validation_tokens: int = DEFAULT_MIN_VALIDATION_TOKENS,
) -> dict:
    freeze = validate_freeze_manifest(
        freeze_path, rights_registry_path=rights_registry_path
    )
    dataset = validate_dataset_manifest_file(dataset_manifest_path)
    report = build_readiness_report(
        freeze,
        dataset,
        min_train_tokens=min_train_tokens,
        min_validation_tokens=min_validation_tokens,
    )
    if not report["ready"]:
        raise ValueError("IMC-125M preflight failed: " + ", ".join(report["failed_checks"]))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--freeze", required=True)
    parser.add_argument("--dataset-manifest", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--min-train-tokens", type=int, default=DEFAULT_MIN_TRAIN_TOKENS)
    parser.add_argument(
        "--min-validation-tokens", type=int, default=DEFAULT_MIN_VALIDATION_TOKENS
    )
    args = parser.parse_args()
    report = validate_imc_125m_readiness(
        args.freeze,
        args.dataset_manifest,
        rights_registry_path=args.rights,
        min_train_tokens=args.min_train_tokens,
        min_validation_tokens=args.min_validation_tokens,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
