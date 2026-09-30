from __future__ import annotations

from data_contract import atomic_write_json
from licensed_tree_sample import build_sample, build_sample_set
from licensed_tree_source import build_manifest


def fixture(tmp_path):
    root = tmp_path / "tree"
    (root / "drivers").mkdir(parents=True)
    (root / "subsys").mkdir(parents=True)
    (root / "drivers" / "a.c").write_text(
        "// SPDX-License-Identifier: Apache-2.0\nint driver_a;\n",
        encoding="utf-8",
    )
    (root / "drivers" / "b.c").write_text(
        "// SPDX-License-Identifier: MIT\nint driver_b;\n",
        encoding="utf-8",
    )
    (root / "subsys" / "net.c").write_text(
        "// SPDX-License-Identifier: Apache-2.0\nint net;\n",
        encoding="utf-8",
    )
    manifest = build_manifest(root, source_name="fixture", source_revision="rev-1")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    return root, manifest_path, manifest


def test_sample_is_deterministic_for_prefixes(tmp_path):
    root, manifest_path, manifest = fixture(tmp_path)
    one = tmp_path / "one.txt"
    two = tmp_path / "two.txt"
    r1 = build_sample(
        manifest_path,
        root=root,
        prefixes=["drivers/"],
        out_path=one,
        max_bytes=10_000,
    )
    r2 = build_sample(
        manifest_path,
        root=root,
        prefixes=["drivers/"],
        out_path=two,
        max_bytes=10_000,
    )
    assert one.read_bytes() == two.read_bytes()
    assert r1["files"] == r2["files"] == ["drivers/a.c", "drivers/b.c"]
    assert r1["source_manifest_sha256"] == manifest["manifest_sha256"]


def test_sample_respects_prefix_and_byte_cap(tmp_path):
    root, manifest_path, _ = fixture(tmp_path)
    out = tmp_path / "sample.txt"
    report = build_sample(
        manifest_path,
        root=root,
        prefixes=["subsys/"],
        out_path=out,
        max_bytes=100,
    )
    assert report["files"] == ["subsys/net.c"]
    assert report["bytes"] <= 100
    assert "drivers/a.c" not in out.read_text(encoding="utf-8")


def test_sample_set_builds_multiple_lanes_from_one_manifest(tmp_path):
    root, manifest_path, _ = fixture(tmp_path)
    reports = build_sample_set(
        manifest_path,
        root=root,
        lanes={"code": ["drivers/"], "tools_protocol": ["subsys/"]},
        out_dir=tmp_path / "samples",
        max_bytes=10_000,
    )
    assert sorted(reports) == ["code", "tools_protocol"]
    assert reports["code"]["file_count"] == 2
    assert reports["tools_protocol"]["file_count"] == 1


def test_sample_round_robins_prefixes_before_byte_cap(tmp_path):
    root, manifest_path, _ = fixture(tmp_path)
    out = tmp_path / "balanced.txt"
    report = build_sample(
        manifest_path,
        root=root,
        prefixes=["drivers/", "subsys/"],
        out_path=out,
        max_bytes=240,
    )
    assert report["files"][0] == "drivers/a.c"
    assert report["files"][1] == "subsys/net.c"
