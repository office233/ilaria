"""Build canonical IMC-125M train/validation curriculum streams from encoded lanes."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    from .concat_streams import _meta
    from .curriculum_stream import REQUIRED_LANES, build_curriculum_stream
    from .data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file
    from .encode_curated_lanes import FORMAT as ENCODED_LANES_FORMAT
except ImportError:
    from concat_streams import _meta
    from curriculum_stream import REQUIRED_LANES, build_curriculum_stream
    from data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file
    from encode_curated_lanes import FORMAT as ENCODED_LANES_FORMAT

FORMAT = "imc-125m-genesis-streams-v1"
DEFAULT_TRAIN_TOKENS = 1_000_000_000
DEFAULT_VALIDATION_TOKENS = 2_097_152

def _load_encoded(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict) or value.get("format") != ENCODED_LANES_FORMAT:
        raise ValueError("unsupported encoded-lanes manifest")
    declared = value.get("encoded_lanes_sha256", "")
    require_lower_sha256("encoded_lanes_sha256", declared)
    payload = dict(value)
    payload.pop("encoded_lanes_sha256", None)
    if hashlib.sha256(canonical_json_bytes(payload)).hexdigest() != declared:
        raise ValueError("encoded-lanes manifest identity mismatch")
    return value

def _lane_prefixes(manifest_path: Path, manifest: dict, split: str) -> dict[str, list[str]]:
    split_record = manifest.get("splits", {}).get(split)
    if not isinstance(split_record, dict) or set(split_record) != REQUIRED_LANES:
        raise ValueError(f"encoded-lanes split mismatch: {split}")
    root = manifest_path.parent.resolve()
    result = {}
    for lane in sorted(REQUIRED_LANES):
        record = split_record[lane]
        streams = record.get("streams") if isinstance(record, dict) else None
        if not isinstance(streams, list):
            raise ValueError(f"encoded-lanes stream list invalid: {split}/{lane}")
        prefixes = []
        for item in streams:
            prefix = item.get("prefix") if isinstance(item, dict) else None
            if not isinstance(prefix, str) or not prefix:
                raise ValueError(f"encoded-lanes prefix invalid: {split}/{lane}")
            full = (root / prefix).resolve()
            if not full.is_relative_to(root):
                raise ValueError(f"encoded-lanes prefix escapes artifact root: {prefix}")
            metadata_path = Path(str(full) + ".json")
            binary_path = Path(str(full) + ".bin")
            if not binary_path.is_file() or not metadata_path.is_file():
                raise ValueError(f"encoded lane stream missing: {full}")
            for field in ("bin_sha256", "meta_sha256"):
                require_lower_sha256(f"encoded stream {field}", item.get(field, ""))
            if sha256_file(metadata_path) != item["meta_sha256"]:
                raise ValueError(f"encoded lane metadata differs from manifest: {prefix}")
            try:
                meta = _meta(str(full))
            except ValueError as exc:
                raise ValueError(f"encoded lane metadata or binary invalid: {prefix}: {exc}") from exc
            if meta.get("stream_sha256") != item["bin_sha256"] or sha256_file(binary_path) != item["bin_sha256"]:
                raise ValueError(f"encoded lane binary differs from manifest: {prefix}")
            if meta["tokenizer_sha256"] != manifest.get("tokenizer", {}).get("sha256"):
                raise ValueError(f"encoded lane tokenizer differs from manifest: {prefix}")
            for field in ("tokens", "documents"):
                if type(item.get(field)) is not int or item[field] != meta[field]:
                    raise ValueError(f"encoded lane {field} differs from manifest: {prefix}")
            prefixes.append(str(full))
        result[lane] = prefixes
    return result

def build_genesis_streams(encoded_manifest_path: str | Path, *, curriculum_path: str | Path, out_dir: str | Path, train_tokens: int = DEFAULT_TRAIN_TOKENS, validation_tokens: int = DEFAULT_VALIDATION_TOKENS) -> dict:
    if train_tokens < 1 or validation_tokens < 1:
        raise ValueError("Genesis stream token targets must be positive")
    manifest_path = Path(encoded_manifest_path).resolve()
    manifest = _load_encoded(manifest_path)
    output = Path(out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    train_prefix = output / "train"
    validation_prefix = output / "validation"
    for prefix in (train_prefix, validation_prefix):
        if Path(str(prefix) + ".bin").exists() or Path(str(prefix) + ".json").exists():
            raise ValueError("Genesis stream output already exists")
    train_lanes = _lane_prefixes(manifest_path, manifest, "train")
    validation_lanes = _lane_prefixes(manifest_path, manifest, "validation")
    train = build_curriculum_stream(str(curriculum_path), lanes=train_lanes, out_prefix=str(train_prefix), target_tokens=train_tokens)
    validation = build_curriculum_stream(str(curriculum_path), lanes=validation_lanes, out_prefix=str(validation_prefix), target_tokens=validation_tokens)
    report = {
        "format": FORMAT,
        "encoded_lanes": {"filename": manifest_path.name, "file_sha256": sha256_file(manifest_path), "identity_sha256": manifest["encoded_lanes_sha256"]},
        "curriculum": {"filename": Path(curriculum_path).name, "sha256": sha256_file(curriculum_path)},
        "train": {"prefix": train_prefix.name, "tokens": int(train["tokens"]), "stream_sha256": train["stream_sha256"], "meta_sha256": sha256_file(str(train_prefix) + ".json")},
        "validation": {"prefix": validation_prefix.name, "tokens": int(validation["tokens"]), "stream_sha256": validation["stream_sha256"], "meta_sha256": sha256_file(str(validation_prefix) + ".json")},
    }
    report["genesis_streams_sha256"] = hashlib.sha256(canonical_json_bytes(report)).hexdigest()
    atomic_write_json(output / "genesis-streams.manifest.json", report)
    return report

def main() -> None:
    config = Path(__file__).resolve().parent / "config" / "imc_125m_curriculum.json"
    parser = argparse.ArgumentParser()
    parser.add_argument("--encoded-manifest", required=True)
    parser.add_argument("--curriculum", default=str(config))
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--train-tokens", type=int, default=DEFAULT_TRAIN_TOKENS)
    parser.add_argument("--validation-tokens", type=int, default=DEFAULT_VALIDATION_TOKENS)
    args = parser.parse_args()
    report = build_genesis_streams(args.encoded_manifest, curriculum_path=args.curriculum, out_dir=args.out_dir, train_tokens=args.train_tokens, validation_tokens=args.validation_tokens)
    print(f"[genesis-streams] train={report['train']['tokens']:,} validation={report['validation']['tokens']:,} sha256={report['genesis_streams_sha256']}")

if __name__ == "__main__":
    main()
