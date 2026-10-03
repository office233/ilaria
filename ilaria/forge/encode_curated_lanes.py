"""Encode curated lane shards with one frozen IlariaLex tokenizer."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    from .curated_lane_shards import FORMAT as LANE_SHARDS_FORMAT
    from .curriculum_stream import REQUIRED_LANES
    from .data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file
    from .hf_tokenizer import encode_jsonl, load
except ImportError:
    from curated_lane_shards import FORMAT as LANE_SHARDS_FORMAT
    from curriculum_stream import REQUIRED_LANES
    from data_contract import atomic_write_json, canonical_json_bytes, require_lower_sha256, sha256_file
    from hf_tokenizer import encode_jsonl, load

FORMAT = "ilaria-encoded-curated-lanes-v1"

def _load_lane_manifest(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict) or manifest.get("format") != LANE_SHARDS_FORMAT:
        raise ValueError("unsupported curated lane-shards manifest")
    declared = manifest.get("lane_shards_sha256", "")
    require_lower_sha256("lane_shards_sha256", declared)
    payload = dict(manifest)
    payload.pop("lane_shards_sha256", None)
    if hashlib.sha256(canonical_json_bytes(payload)).hexdigest() != declared:
        raise ValueError("curated lane-shards manifest identity mismatch")
    splits = manifest.get("splits")
    if not isinstance(splits, dict) or set(splits) != {"train", "validation"}:
        raise ValueError("curated lane-shards split set mismatch")
    for split, lanes in splits.items():
        if not isinstance(lanes, dict) or set(lanes) != REQUIRED_LANES:
            raise ValueError(f"curated lane-shards lane set mismatch for {split}")
    return manifest

def encode_lane_shards(lane_manifest_path: str | Path, *, tokenizer_path: str | Path, out_dir: str | Path) -> dict:
    manifest_path = Path(lane_manifest_path).resolve()
    manifest = _load_lane_manifest(manifest_path)
    tokenizer_path = Path(tokenizer_path).resolve()
    if not tokenizer_path.is_file():
        raise ValueError(f"tokenizer does not exist: {tokenizer_path}")
    tokenizer = load(str(tokenizer_path))
    output = Path(out_dir).resolve()
    if output.exists() and any(output.rglob("*.bin")):
        raise ValueError("encoded lane output already contains token streams")
    output.mkdir(parents=True, exist_ok=True)
    encoded = {"train": {}, "validation": {}}
    total_tokens = 0
    total_documents = 0
    for split in ("train", "validation"):
        for lane in sorted(REQUIRED_LANES):
            lane_record = manifest["splits"][split][lane]
            shards = lane_record.get("shards")
            if not isinstance(shards, list):
                raise ValueError(f"invalid curated lane shard list: {split}/{lane}")
            records = []
            lane_tokens = 0
            lane_documents = 0
            for index, record in enumerate(shards):
                filename = record.get("filename")
                digest = record.get("sha256", "")
                require_lower_sha256(f"{split}/{lane} shard sha256", digest)
                if not isinstance(filename, str) or not filename:
                    raise ValueError(f"invalid curated lane shard filename: {split}/{lane}")
                source_path = manifest_path.parent / filename
                if not source_path.is_file():
                    raise ValueError(f"curated lane shard missing: {source_path}")
                if source_path.stat().st_size != int(record.get("bytes", -1)):
                    raise ValueError(f"curated lane shard size mismatch: {filename}")
                if sha256_file(source_path) != digest:
                    raise ValueError(f"curated lane shard hash mismatch: {filename}")
                lane_dir = output / split / lane
                lane_dir.mkdir(parents=True, exist_ok=True)
                prefix = lane_dir / f"{lane}-{index:05d}"
                meta = encode_jsonl(tokenizer, str(source_path), str(prefix), str(tokenizer_path))
                records.append({
                    "prefix": str(prefix.relative_to(output)).replace("\\\\", "/"),
                    "input_filename": filename,
                    "input_sha256": digest,
                    "bin_sha256": meta["stream_sha256"],
                    "meta_sha256": sha256_file(str(prefix) + ".json"),
                    "tokens": int(meta["tokens"]),
                    "documents": int(meta["documents"]),
                })
                lane_tokens += int(meta["tokens"])
                lane_documents += int(meta["documents"])
            if lane_documents != int(lane_record.get("documents", -1)):
                raise ValueError(f"encoded document count mismatch for {split}/{lane}")
            encoded[split][lane] = {"documents": lane_documents, "tokens": lane_tokens, "streams": records}
            total_tokens += lane_tokens
            total_documents += lane_documents
    report = {
        "format": FORMAT,
        "lane_shards": {
            "filename": manifest_path.name,
            "file_sha256": sha256_file(manifest_path),
            "identity_sha256": manifest["lane_shards_sha256"],
        },
        "tokenizer": {"filename": tokenizer_path.name, "sha256": sha256_file(tokenizer_path)},
        "splits": encoded,
        "totals": {"documents": total_documents, "tokens": total_tokens},
    }
    report["encoded_lanes_sha256"] = hashlib.sha256(canonical_json_bytes(report)).hexdigest()
    atomic_write_json(output / "encoded-lanes.manifest.json", report)
    return report

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane-manifest", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    report = encode_lane_shards(args.lane_manifest, tokenizer_path=args.tokenizer, out_dir=args.out_dir)
    print(f"[encode-curated-lanes] documents={report['totals']['documents']} tokens={report['totals']['tokens']} sha256={report['encoded_lanes_sha256']}")

if __name__ == "__main__":
    main()
