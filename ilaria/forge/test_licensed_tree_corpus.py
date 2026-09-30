from __future__ import annotations

import json

import pytest

from curate_corpus import curate
from data_contract import RIGHTS_APPROVED, atomic_write_json
from licensed_tree_corpus import build_raw_corpus
from licensed_tree_source import build_manifest


def fixture(tmp_path):
    root = tmp_path / "tree"
    root.mkdir()
    for index in range(3):
        (root / f"file{index}.c").write_text(
            "// SPDX-License-Identifier: Apache-2.0\n"
            f"int value_{index} = {index}; enough source text for corpus.\n",
            encoding="utf-8",
        )
    licensed = build_manifest(root, source_name="zephyr", source_revision="a" * 40)
    licensed_path = tmp_path / "licensed.json"
    atomic_write_json(licensed_path, licensed)
    return root, licensed_path, licensed


def test_adapter_emits_canonical_raw_source_manifest(tmp_path):
    root, licensed_path, licensed = fixture(tmp_path)
    out = tmp_path / "raw"
    manifest = build_raw_corpus(
        licensed_path,
        root=root,
        out_dir=out,
        source_name="zephyr",
        provider="https://github.com/zephyrproject-rtos/zephyr.git",
        shard_docs=2,
    )
    assert manifest["schema_version"] == 2
    assert manifest["docs"] == 3
    assert manifest["shards"] == 2
    assert manifest["pipeline"]["licensed_tree_manifest_sha256"] == licensed["manifest_sha256"]
    rows = []
    for record in manifest["shard_records"]:
        rows.extend(
            json.loads(line)
            for line in (out / record["filename"]).read_text(encoding="utf-8").splitlines()
        )
    assert all(row["spdx"] == "Apache-2.0" for row in rows)
    assert all(row["text"].startswith("[FILE ") for row in rows)


def test_curation_remains_the_rights_gate(tmp_path):
    root, licensed_path, _ = fixture(tmp_path)
    raw = tmp_path / "raw"
    build_raw_corpus(
        licensed_path,
        root=root,
        out_dir=raw,
        source_name="zephyr",
        provider="https://github.com/zephyrproject-rtos/zephyr.git",
        shard_docs=2,
    )
    rights = tmp_path / "rights.json"
    atomic_write_json(
        rights,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                "zephyr": {
                    "status": "REVIEW_REQUIRED",
                    "commercial_use_approved": False,
                    "review_ref": "",
                }
            },
        },
    )
    with pytest.raises(ValueError, match="not approved"):
        curate(
            [str(raw / "zephyr.manifest.json")],
            rights_registry_path=str(rights),
            benchmark_paths=[],
            out_dir=str(tmp_path / "curated"),
        )

    approved = json.loads(rights.read_text(encoding="utf-8"))
    approved["sources"]["zephyr"].update(
        {
            "status": RIGHTS_APPROVED,
            "commercial_use_approved": True,
            "review_ref": "fixture-review",
        }
    )
    atomic_write_json(rights, approved)
    report = curate(
        [str(raw / "zephyr.manifest.json")],
        rights_registry_path=str(rights),
        benchmark_paths=[],
        out_dir=str(tmp_path / "curated-approved"),
        validation_fraction=0.25,
        shingle_width=4,
        shard_docs=2,
    )
    assert report["totals"]["input_documents"] == 3
