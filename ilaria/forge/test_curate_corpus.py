import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from curate_corpus import curate, validation_side  # noqa: E402
from data_contract import (  # noqa: E402
    CORPUS_MANIFEST_SCHEMA,
    RIGHTS_APPROVED,
    atomic_write_json,
    sha256_file,
)


def source_fixture(tmp_path, name, texts):
    shard = tmp_path / f"{name}-00000.jsonl"
    shard.write_text(
        "".join(
            json.dumps({"text": text}, ensure_ascii=False) + "\n"
            for text in texts
        ),
        encoding="utf-8",
    )
    manifest = tmp_path / f"{name}.manifest.json"
    atomic_write_json(
        manifest,
        {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": {
                "name": name,
                "provider": f"fixture/{name}",
                "revision": "v1",
                "language": "en",
            },
            "pipeline": {"name": "fixture"},
            "docs": len(texts),
            "shards": 1,
            "complete": [0],
            "raw_rows": len(texts),
            "shard_records": [
                {
                    "index": 0,
                    "filename": shard.name,
                    "sha256": sha256_file(shard),
                    "bytes": shard.stat().st_size,
                    "documents": len(texts),
                }
            ],
        },
    )
    return manifest


def rights_fixture(tmp_path, names, approved=True):
    path = tmp_path / "rights.json"
    atomic_write_json(
        path,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                name: {
                    "status": RIGHTS_APPROVED
                    if approved
                    else "REVIEW_REQUIRED",
                    "commercial_use_approved": approved,
                    "review_ref": "review-fixture" if approved else "",
                }
                for name in names
            },
        },
    )
    return path


def test_split_is_content_deterministic():
    digest = "0123456789abcdef" * 4
    assert validation_side(digest, 0.2) == validation_side(digest, 0.2)


def test_curate_removes_duplicates_and_benchmark_leakage(tmp_path):
    common = "same normalized duplicate document with enough words"
    leak = "alpha beta gamma delta epsilon zeta eta theta leakage"
    a = source_fixture(
        tmp_path,
        "a",
        [
            common,
            "unique source a document with enough words",
            leak,
        ],
    )
    b = source_fixture(
        tmp_path,
        "b",
        [
            common.upper(),
            "unique source b document with enough words",
        ],
    )
    rights = rights_fixture(tmp_path, ["a", "b"])
    benchmark = tmp_path / "bench.txt"
    benchmark.write_text(
        "alpha beta gamma delta epsilon zeta eta theta\n",
        encoding="utf-8",
    )

    out = tmp_path / "curated"
    report = curate(
        [str(b), str(a)],
        rights_registry_path=str(rights),
        benchmark_paths=[str(benchmark)],
        out_dir=str(out),
        validation_fraction=0.25,
        shingle_width=6,
        shard_docs=2,
    )

    assert report["totals"]["input_documents"] == 5
    assert report["totals"]["duplicates_removed"] == 1
    assert report["totals"]["contamination_removed"] == 1
    assert report["totals"]["kept_documents"] == 3
    assert (
        report["totals"]["train_documents"]
        + report["totals"]["validation_documents"]
        == 3
    )

    rows = []
    for split in ("train", "validation"):
        for record in report["splits"][split]:
            shard = out / record["filename"]
            assert sha256_file(shard) == record["sha256"]
            rows.extend(
                json.loads(line)
                for line in shard.read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
    assert len(rows) == 3
    assert len({row["document_sha256"] for row in rows}) == 3
    assert all("alpha beta gamma" not in row["text"] for row in rows)


def test_curate_is_deterministic_across_input_order(tmp_path):
    a = source_fixture(
        tmp_path,
        "a",
        ["alpha clean document one", "alpha clean document two"],
    )
    b = source_fixture(
        tmp_path,
        "b",
        ["beta clean document one", "beta clean document two"],
    )
    rights = rights_fixture(tmp_path, ["a", "b"])
    out1, out2 = tmp_path / "out1", tmp_path / "out2"

    one = curate(
        [str(a), str(b)],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(out1),
        validation_fraction=0.25,
        shingle_width=4,
        shard_docs=2,
    )
    two = curate(
        [str(b), str(a)],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(out2),
        validation_fraction=0.25,
        shingle_width=4,
        shard_docs=2,
    )

    assert one["curated_manifest_sha256"] == two["curated_manifest_sha256"]
    for split in ("train", "validation"):
        assert [x["sha256"] for x in one["splits"][split]] == [
            x["sha256"] for x in two["splits"][split]
        ]


def test_curate_rejects_unapproved_source(tmp_path):
    manifest = source_fixture(
        tmp_path, "a", ["clean document with enough text here"]
    )
    rights = rights_fixture(tmp_path, ["a"], approved=False)
    with pytest.raises(ValueError, match="not approved"):
        curate(
            [str(manifest)],
            rights_registry_path=str(rights),
            benchmark_paths=[],
            out_dir=str(tmp_path / "out"),
        )
