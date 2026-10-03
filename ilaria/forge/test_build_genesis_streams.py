from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from build_genesis_streams import build_genesis_streams
from curriculum_stream import REQUIRED_LANES
from data_contract import atomic_write_json, canonical_json_bytes, sha256_file
from test_curriculum_stream import curriculum_path, write_stream

def _encoded_manifest(tmp_path: Path) -> Path:
    splits = {}
    for split in ("train", "validation"):
        split_root = tmp_path / split
        split_root.mkdir(parents=True, exist_ok=True)
        splits[split] = {}
        for lane in sorted(REQUIRED_LANES):
            if lane == "romanian_multilingual":
                splits[split][lane] = {"documents": 0, "tokens": 0, "streams": []}
                continue
            prefix = write_stream(split_root, lane, 200)
            relative = str(Path(prefix).relative_to(tmp_path)).replace("\\", "/")
            metadata = json.loads(Path(prefix + ".json").read_text(encoding="utf-8"))
            metadata["stream_sha256"] = sha256_file(prefix + ".bin")
            atomic_write_json(prefix + ".json", metadata)
            splits[split][lane] = {
                "documents": metadata["documents"],
                "tokens": 200,
                "streams": [{"prefix": relative, "bin_sha256": metadata["stream_sha256"],
                             "meta_sha256": sha256_file(prefix + ".json"), "tokens": metadata["tokens"],
                             "documents": metadata["documents"]}],
            }
    value = {
        "format": "ilaria-encoded-curated-lanes-v1",
        "lane_shards": {"filename": "fixture", "file_sha256": "a" * 64, "identity_sha256": "b" * 64},
        "tokenizer": {"filename": "ilarialex.json", "sha256": "a" * 64},
        "splits": splits,
        "totals": {"documents": 280, "tokens": 2800},
    }
    value["encoded_lanes_sha256"] = hashlib.sha256(canonical_json_bytes(value)).hexdigest()
    path = tmp_path / "encoded-lanes.manifest.json"
    atomic_write_json(path, value)
    return path

def test_build_genesis_streams_materializes_both_curriculum_splits(tmp_path: Path):
    report = build_genesis_streams(
        _encoded_manifest(tmp_path),
        curriculum_path=curriculum_path(),
        out_dir=tmp_path / "genesis",
        train_tokens=100,
        validation_tokens=100,
    )
    assert report["train"]["tokens"] == 100
    assert report["validation"]["tokens"] == 100
    assert len(report["genesis_streams_sha256"]) == 64
    assert (tmp_path / "genesis" / "train.bin").is_file()
    assert (tmp_path / "genesis" / "validation.bin").is_file()


@pytest.mark.parametrize("tamper", ["metadata", "binary", "binary-content", "tokenizer", "tokens", "escape"])
def test_build_genesis_streams_rejects_changed_encoded_lineage_before_publishing(tmp_path: Path, tamper):
    path = _encoded_manifest(tmp_path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    item = manifest["splits"]["validation"]["code"]["streams"][0]
    if tamper == "metadata":
        metadata_path = tmp_path / (item["prefix"] + ".json")
        metadata_path.write_text(metadata_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    elif tamper == "binary":
        item["bin_sha256"] = "b" * 64
    elif tamper == "binary-content":
        binary_path = tmp_path / (item["prefix"] + ".bin")
        contents = bytearray(binary_path.read_bytes())
        contents[0] = (contents[0] + 1) % 100
        binary_path.write_bytes(contents)
    elif tamper == "tokenizer":
        manifest["tokenizer"]["sha256"] = "b" * 64
    elif tamper == "tokens":
        item["tokens"] += 1
    else:
        item["prefix"] = "../outside"
    manifest.pop("encoded_lanes_sha256")
    manifest["encoded_lanes_sha256"] = hashlib.sha256(canonical_json_bytes(manifest)).hexdigest()
    atomic_write_json(path, manifest)
    output = tmp_path / "genesis"
    with pytest.raises(ValueError, match="encoded"):
        build_genesis_streams(path, curriculum_path=curriculum_path(), out_dir=output,
                              train_tokens=100, validation_tokens=100)
    assert not (output / "train.bin").exists()
    assert not (output / "validation.bin").exists()
