from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_contract import atomic_write_json, sha256_file
from tokenizer_candidate_sample import REQUIRED_CATEGORIES, build_candidate_sample


def _source(tmp_path: Path, name: str, texts: list[str]) -> Path:
    shard = tmp_path / f"{name}-00000.jsonl"
    shard.write_text(
        "".join(json.dumps({"text": text, "path": f"{name}/{i}"}) + "\n" for i, text in enumerate(texts)),
        encoding="utf-8",
    )
    manifest = {
        "schema_version": 1,
        "source": {"name": name, "revision": "a" * 40},
        "shard_records": [
            {
                "index": 0,
                "filename": shard.name,
                "sha256": sha256_file(shard),
                "bytes": shard.stat().st_size,
                "documents": len(texts),
            }
        ],
    }
    path = tmp_path / f"{name}.manifest.json"
    atomic_write_json(path, manifest)
    return path


def test_candidate_sample_is_balanced_content_addressed_and_text_only(tmp_path):
    source = _source(tmp_path, "fixture", ["alpha beta gamma", "delta epsilon zeta"])
    entries = {category: [source] for category in REQUIRED_CATEGORIES}
    out = tmp_path / "sample"
    manifest = build_candidate_sample(entries, out_dir=out, bytes_per_category=10)
    assert manifest["production_eligible"] is False
    assert len(manifest["sample_sha256"]) == 64
    for category in REQUIRED_CATEGORIES:
        record = manifest["categories"][category]
        text = (out / record["filename"]).read_text(encoding="utf-8")
        assert "alpha beta gamma" in text
        assert '"text"' not in text
        assert record["sha256"] == sha256_file(out / record["filename"])


def test_candidate_sample_rejects_tampered_shard(tmp_path):
    source = _source(tmp_path, "fixture", ["alpha beta gamma"])
    data = json.loads(source.read_text(encoding="utf-8"))
    shard = tmp_path / data["shard_records"][0]["filename"]
    shard.write_text('{"text":"tampered"}\n', encoding="utf-8")
    entries = {category: [source] for category in REQUIRED_CATEGORIES}
    with pytest.raises(ValueError, match="size mismatch|hash mismatch"):
        build_candidate_sample(entries, out_dir=tmp_path / "out", bytes_per_category=10)
