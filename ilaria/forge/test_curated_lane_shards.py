from __future__ import annotations

import json
from pathlib import Path

from curate_corpus import curate
from curated_lane_shards import split_curated_lanes
from data_contract import (
    CORPUS_MANIFEST_SCHEMA,
    RIGHTS_APPROVED,
    atomic_write_json,
    sha256_file,
)


def _source(tmp_path: Path) -> Path:
    shard = tmp_path / "source-00000.jsonl"
    rows = [
        {"text": f"driver document {index} with unique payload", "path": f"drivers/x{index}.c"}
        for index in range(12)
    ] + [
        {"text": f"general code document {index} with unique payload", "path": f"lib/x{index}.c"}
        for index in range(12)
    ]
    shard.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    manifest = tmp_path / "source.manifest.json"
    atomic_write_json(
        manifest,
        {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": {
                "name": "fixture_source",
                "provider": "fixture",
                "revision": "v1",
                "language": "en",
            },
            "pipeline": {"name": "fixture"},
            "docs": len(rows),
            "shards": 1,
            "complete": [0],
            "raw_rows": len(rows),
            "shard_records": [
                {
                    "index": 0,
                    "filename": shard.name,
                    "sha256": sha256_file(shard),
                    "bytes": shard.stat().st_size,
                    "documents": len(rows),
                }
            ],
        },
    )
    return manifest


def _rights(tmp_path: Path) -> Path:
    path = tmp_path / "rights.json"
    atomic_write_json(
        path,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                "fixture_source": {
                    "status": RIGHTS_APPROVED,
                    "commercial_use_approved": True,
                    "review_ref": "fixture-review",
                }
            },
        },
    )
    return path


def _lane_rules(tmp_path: Path) -> Path:
    path = tmp_path / "lanes.json"
    atomic_write_json(
        path,
        {
            "format": "imc-125m-inventory-lanes-v1",
            "sources": {
                "fixture_source": {
                    "rules": [
                        {
                            "lane": "os_hardware_drivers_standards",
                            "path_globs": ["drivers/**"],
                        },
                        {"lane": "code", "default": True},
                    ]
                }
            },
        },
    )
    return path


def test_curated_lane_split_preserves_deterministic_classification(tmp_path: Path):
    curated_dir = tmp_path / "curated"
    curated = curate(
        [str(_source(tmp_path))],
        rights_registry_path=str(_rights(tmp_path)),
        benchmark_paths=[],
        out_dir=str(curated_dir),
        validation_fraction=0.5,
        shard_docs=5,
        lane_rules_path=str(_lane_rules(tmp_path)),
    )
    assert curated["by_lane"]["code"]["kept_documents"] == 12
    assert (
        curated["by_lane"]["os_hardware_drivers_standards"]["kept_documents"]
        == 12
    )
    assert curated["lane_rules"]["identity_sha256"]

    output = tmp_path / "lanes"
    report = split_curated_lanes(
        curated_dir / "curated.manifest.json",
        out_dir=output,
        shard_docs=3,
    )
    assert report["totals"]["train"] + report["totals"]["validation"] == 24

    observed = {"code": 0, "os_hardware_drivers_standards": 0}
    for split in ("train", "validation"):
        for lane in observed:
            record = report["splits"][split][lane]
            observed[lane] += record["documents"]
            for shard_record in record["shards"]:
                shard = output / shard_record["filename"]
                assert sha256_file(shard) == shard_record["sha256"]
                for line in shard.read_text(encoding="utf-8").splitlines():
                    row = json.loads(line)
                    assert row["lane"] == lane
                    assert "source_path" in row
    assert observed == {"code": 12, "os_hardware_drivers_standards": 12}


def test_lane_split_rejects_curated_corpus_without_lane_rules(tmp_path: Path):
    curated_dir = tmp_path / "curated"
    curate(
        [str(_source(tmp_path))],
        rights_registry_path=str(_rights(tmp_path)),
        benchmark_paths=[],
        out_dir=str(curated_dir),
        validation_fraction=0.5,
        shard_docs=5,
    )
    try:
        split_curated_lanes(
            curated_dir / "curated.manifest.json",
            out_dir=tmp_path / "lanes",
        )
    except ValueError as exc:
        assert "no pinned lane rules" in str(exc)
    else:
        raise AssertionError("lane split accepted a curated corpus without lane rules")
