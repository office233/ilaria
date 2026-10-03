"""Deterministic IMC architecture/model manifest.

The manifest identifies the exact IMC architecture contract independently from
mutable training state. Checkpoints, ExpertGenome records and distributed jobs
can pin the resulting architecture_hash and tokenizer hash.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from atomic_io import atomic_binary_writer
from data_contract import require_lower_sha256
from hf_tokenizer import (
    EOS,
    ILARIALEX_BASE_VOCAB_SIZE,
    ILARIALEX_FORMAT,
    ILARIALEX_PROTOCOL_RESERVED,
    ILARIALEX_VOCAB_SIZE,
)
from imc_model import PRESETS, ImcConfig

SCHEMA_VERSION = 1
MODEL_FAMILY = "IMC"
ARCHITECTURE_VERSION = "ilaria-microcortex-v1"


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _validate_tokenizer_identity(data: dict) -> None:
    expected = {
        "format": ILARIALEX_FORMAT,
        "vocab_size": ILARIALEX_VOCAB_SIZE,
        "base_vocab_size": ILARIALEX_BASE_VOCAB_SIZE,
        "protocol_reserved": ILARIALEX_PROTOCOL_RESERVED,
        "protocol_start_id": ILARIALEX_BASE_VOCAB_SIZE,
        "eos_id": ILARIALEX_BASE_VOCAB_SIZE,
        "eos_token": EOS,
    }
    for name, value in expected.items():
        if type(data.get(name)) is not type(value) or data[name] != value:
            raise ValueError(f"canonical IMC tokenizer {name} must be {value!r}")


def load_tokenizer_identity(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError("tokenizer identity must be a JSON object")
    if data.get("format") != ILARIALEX_FORMAT:
        raise ValueError(
            f"tokenizer must use {ILARIALEX_FORMAT}, got {data.get('format')!r}"
        )
    required = (
        "vocab_size",
        "base_vocab_size",
        "protocol_reserved",
        "protocol_start_id",
        "eos_id",
        "eos_token",
    )
    missing = [name for name in required if name not in data]
    if missing:
        raise ValueError(
            "tokenizer identity missing fields: " + ", ".join(missing)
        )
    _validate_tokenizer_identity(data)
    return {
        "format": data["format"],
        "vocab_size": int(data["vocab_size"]),
        "base_vocab_size": int(data["base_vocab_size"]),
        "protocol_reserved": int(data["protocol_reserved"]),
        "protocol_start_id": int(data["protocol_start_id"]),
        "eos_id": data["eos_id"],
        "eos_token": data["eos_token"],
        "sha256": sha256_file(path),
    }


def build_manifest(
    cfg: ImcConfig,
    *,
    preset: str,
    tokenizer_identity: dict,
    source_sha256: str,
) -> dict:
    require_lower_sha256("tokenizer sha256", tokenizer_identity["sha256"])
    require_lower_sha256("source_sha256", source_sha256)
    _validate_tokenizer_identity(tokenizer_identity)
    if preset not in PRESETS:
        raise ValueError(f"unknown IMC preset: {preset}")
    if any(getattr(cfg, field) != value for field, value in PRESETS[preset].items()):
        raise ValueError("model dimensions do not match the declared preset")
    if cfg.vocab_size != tokenizer_identity["vocab_size"]:
        raise ValueError("model vocab size does not match tokenizer")
    if cfg.eos_token_id != tokenizer_identity["eos_id"]:
        raise ValueError("model EOS ID does not match tokenizer")

    config = cfg.to_json()
    identity = {
        "schema_version": SCHEMA_VERSION,
        "model_family": MODEL_FAMILY,
        "architecture_version": ARCHITECTURE_VERSION,
        "preset": preset,
        "parameter_count": cfg.param_count(),
        "config": config,
        "tokenizer": dict(tokenizer_identity),
        "source_sha256": source_sha256,
    }
    identity["config_sha256"] = hashlib.sha256(
        canonical_json_bytes(config)
    ).hexdigest()
    identity["architecture_hash"] = hashlib.sha256(
        canonical_json_bytes(identity)
    ).hexdigest()
    return identity


def validate_architecture_manifest_file(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict):
        raise ValueError("architecture manifest must be a JSON object")
    declared = manifest.get("architecture_hash", "")
    require_lower_sha256("architecture_hash", declared)
    unhashed = dict(manifest)
    del unhashed["architecture_hash"]
    actual = hashlib.sha256(canonical_json_bytes(unhashed)).hexdigest()
    if actual != declared:
        raise ValueError("architecture manifest identity hash mismatch")
    if manifest.get("model_family") != MODEL_FAMILY:
        raise ValueError("architecture manifest has wrong model family")
    if manifest.get("architecture_version") != ARCHITECTURE_VERSION:
        raise ValueError("architecture manifest has wrong architecture version")
    if manifest.get("preset") not in PRESETS:
        raise ValueError("architecture manifest has unknown preset")
    config = manifest.get("config")
    tokenizer = manifest.get("tokenizer")
    if not isinstance(config, dict) or not isinstance(tokenizer, dict):
        raise ValueError("architecture manifest config/tokenizer missing")
    if int(config.get("vocab_size", -1)) != int(tokenizer.get("vocab_size", -2)):
        raise ValueError("architecture/tokenizer vocab mismatch")
    if int(config.get("eos_token_id", -1)) != int(tokenizer.get("eos_id", -2)):
        raise ValueError("architecture/tokenizer EOS mismatch")
    try:
        rebuilt = build_manifest(
            ImcConfig.from_json(config), preset=manifest["preset"],
            tokenizer_identity=tokenizer, source_sha256=manifest["source_sha256"],
        )
    except (KeyError, TypeError) as exc:
        raise ValueError("architecture manifest is incomplete") from exc
    if rebuilt != manifest:
        raise ValueError("architecture manifest differs from its reconstructed model contract")
    return manifest


def write_manifest(path: str | Path, manifest: dict) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        manifest, sort_keys=True, indent=2, ensure_ascii=False
    ).encode("utf-8") + b"\n"
    with atomic_binary_writer(destination) as stream:
        stream.write(payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", required=True, choices=sorted(PRESETS))
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--weight-mode", required=True, choices=("ternary", "full")
    )
    parser.add_argument("--max-seq-len", type=int, default=2_048)
    args = parser.parse_args()

    tokenizer_path = Path(args.tokenizer)
    if not tokenizer_path.is_file():
        parser.error(f"tokenizer does not exist: {tokenizer_path}")
    if args.max_seq_len <= 0:
        parser.error("max sequence length must be positive")

    try:
        tokenizer_identity = load_tokenizer_identity(tokenizer_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))

    cfg = ImcConfig.preset(
        args.preset,
        vocab_size=tokenizer_identity["vocab_size"],
        max_seq_len=args.max_seq_len,
        eos_token_id=tokenizer_identity["eos_id"],
        ternary=args.weight_mode == "ternary",
    )
    source_path = Path(__file__).with_name("imc_model.py")
    manifest = build_manifest(
        cfg,
        preset=args.preset,
        tokenizer_identity=tokenizer_identity,
        source_sha256=sha256_file(source_path),
    )
    write_manifest(args.out, manifest)
    print(
        f"wrote {args.out}: {manifest['parameter_count']:,} params "
        f"architecture_hash={manifest['architecture_hash']}"
    )


if __name__ == "__main__":
    main()
