from __future__ import annotations

from pathlib import Path

import pytest

from curated_lane_shards import split_curated_lanes
from encode_curated_lanes import encode_lane_shards
from hf_tokenizer import train
from test_hf_tokenizer import SAMPLE
from test_curated_lane_shards import _lane_rules, _rights, _source
from curate_corpus import curate

def _tokenizer(tmp_path: Path) -> Path:
    sample = tmp_path / "sample.txt"
    sample.write_text("\n".join(SAMPLE) + "\n", encoding="utf-8")
    out = tmp_path / "ilarialex.json"
    train([str(sample)], 560, str(out), protocol_reserve=64)
    return out

def _lanes(tmp_path: Path) -> Path:
    curated_dir = tmp_path / "curated"
    curate(
        [str(_source(tmp_path))],
        rights_registry_path=str(_rights(tmp_path)),
        benchmark_paths=[],
        out_dir=str(curated_dir),
        validation_fraction=0.5,
        shard_docs=5,
        lane_rules_path=str(_lane_rules(tmp_path)),
    )
    out = tmp_path / "lanes"
    split_curated_lanes(
        curated_dir / "curated.manifest.json",
        out_dir=out,
        shard_docs=3,
    )
    return out / "lane-shards.manifest.json"

def test_encode_curated_lanes_preserves_documents_and_hashes(tmp_path: Path):
    report = encode_lane_shards(
        _lanes(tmp_path),
        tokenizer_path=_tokenizer(tmp_path),
        out_dir=tmp_path / "encoded",
    )
    assert report["totals"]["documents"] == 24
    assert report["totals"]["tokens"] > 24
    assert len(report["encoded_lanes_sha256"]) == 64
    for split in ("train", "validation"):
        for lane, record in report["splits"][split].items():
            if record["documents"]:
                assert record["streams"], lane
                assert sum(item["documents"] for item in record["streams"]) == record["documents"]

def test_encode_curated_lanes_rejects_tampered_input(tmp_path: Path):
    lane_manifest = _lanes(tmp_path)
    import json
    manifest = json.loads(lane_manifest.read_text(encoding="utf-8"))
    record = next(
        shard
        for split in ("train", "validation")
        for lane in manifest["splits"][split].values()
        for shard in lane["shards"]
    )
    shard_path = lane_manifest.parent / record["filename"]
    shard_path.write_text('{"text":"tampered"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="size mismatch|hash mismatch"):
        encode_lane_shards(
            lane_manifest,
            tokenizer_path=_tokenizer(tmp_path),
            out_dir=tmp_path / "encoded",
        )
