from __future__ import annotations

import json

import pytest

from data_contract import atomic_write_json
from go_license_reference import has_go_root_license_reference
from go_licensed_tree_source import build_go_manifest
from licensed_tree_source import validate_manifest


GO_HEADER = (
    "// Copyright 2026 The Go Authors. All rights reserved.\n"
    "// Use of this source code is governed by a BSD-style\n"
    "// license that can be found in the LICENSE file.\n\n"
)


def _tree(root):
    (root / "LICENSE").write_text("fixture BSD-3-Clause text\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "good.go").write_text(
        GO_HEADER + "package good\n", encoding="utf-8"
    )
    (root / "src" / "foreign.go").write_text(
        "// Copyright Someone Else\npackage foreign\n", encoding="utf-8"
    )
    (root / "AGENTS.md").write_text(
        GO_HEADER + "agent instructions\n", encoding="utf-8"
    )


def test_go_notice_requires_copyright_and_license_reference(tmp_path):
    good = tmp_path / "good.go"
    good.write_text(GO_HEADER + "package good\n", encoding="utf-8")
    bad = tmp_path / "bad.go"
    bad.write_text(
        "// Use of this source code is governed by a BSD-style\n"
        "// license that can be found in the LICENSE file.\n",
        encoding="utf-8",
    )
    assert has_go_root_license_reference(good)
    assert not has_go_root_license_reference(bad)


def test_go_manifest_is_fail_closed_on_files_without_notice(tmp_path):
    root = tmp_path / "go"
    root.mkdir()
    _tree(root)
    manifest = build_go_manifest(root, source_revision="deadbeef")
    assert [record["path"] for record in manifest["files"]] == ["src/good.go"]
    assert manifest["totals"]["rejected"]["no_root_license_reference"] == 1
    assert manifest["totals"]["rejected"]["denied_filename"] == 1

    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    assert validate_manifest(manifest_path, root=root) == manifest


def test_go_manifest_detects_notice_drift(tmp_path):
    root = tmp_path / "go"
    root.mkdir()
    _tree(root)
    manifest = build_go_manifest(root, source_revision="deadbeef")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)

    source = root / "src" / "good.go"
    source.write_text("package good\n", encoding="utf-8")
    with pytest.raises(ValueError, match="size mismatch|hash mismatch|SPDX changed"):
        validate_manifest(manifest_path, root=root)


def test_go_manifest_detects_root_license_drift(tmp_path):
    root = tmp_path / "go"
    root.mkdir()
    _tree(root)
    manifest = build_go_manifest(root, source_revision="deadbeef")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    (root / "LICENSE").write_text("changed\n", encoding="utf-8")
    with pytest.raises(ValueError, match="license evidence hash mismatch"):
        validate_manifest(manifest_path, root=root)
