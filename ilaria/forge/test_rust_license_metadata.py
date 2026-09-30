from __future__ import annotations

import json
from pathlib import Path

import pytest

from data_contract import atomic_write_json
from licensed_tree_source import validate_manifest
from rust_license_metadata import build_rules, resolve_spdx
from rust_licensed_tree_source import build_rust_manifest


def _metadata() -> dict:
    return {
        "files": {
            "type": "root",
            "children": [
                {
                    "type": "directory",
                    "name": ".",
                    "license": {
                        "spdx": "Apache-2.0 OR MIT",
                        "copyright": ["Fixture"],
                    },
                    "children": [
                        {
                            "type": "directory",
                            "name": "third_party",
                            "license": {
                                "spdx": "GPL-3.0-only",
                                "copyright": ["Third Party"],
                            },
                            "children": [
                                {
                                    "type": "file",
                                    "name": "safe.rs",
                                    "license": {
                                        "spdx": "MIT",
                                        "copyright": ["Fixture"],
                                    },
                                }
                            ],
                        },
                        {
                            "type": "group",
                            "files": ["generated/special.rs"],
                            "directories": [],
                            "license": {
                                "spdx": "Unicode-3.0",
                                "copyright": ["Unicode"],
                            },
                        },
                    ],
                }
            ],
        }
    }


def _write_tree(root: Path) -> None:
    (root / "third_party").mkdir(parents=True)
    (root / "generated").mkdir()
    (root / "src").mkdir()
    (root / "src" / "main.rs").write_text("fn main() {}\n", encoding="utf-8")
    (root / "third_party" / "bad.rs").write_text("fn bad() {}\n", encoding="utf-8")
    (root / "third_party" / "safe.rs").write_text("fn safe() {}\n", encoding="utf-8")
    (root / "generated" / "special.rs").write_text("const X: u8 = 1;\n", encoding="utf-8")
    (root / "AGENTS.md").write_text("do not ingest\n", encoding="utf-8")
    (root / "license-metadata.json").write_text(
        json.dumps(_metadata(), sort_keys=True), encoding="utf-8"
    )


def test_rules_use_most_specific_file_and_directory_override():
    rules = build_rules(_metadata())
    assert resolve_spdx("src/main.rs", rules) == "Apache-2.0 OR MIT"
    assert resolve_spdx("third_party/bad.rs", rules) == "GPL-3.0-only"
    assert resolve_spdx("third_party/safe.rs", rules) == "MIT"
    assert resolve_spdx("generated/special.rs", rules) == "Unicode-3.0"


def test_rust_manifest_uses_metadata_without_inline_spdx(tmp_path):
    root = tmp_path / "rust"
    root.mkdir()
    _write_tree(root)
    manifest = build_rust_manifest(root, source_revision="abc123")
    paths = [record["path"] for record in manifest["files"]]

    assert "src/main.rs" in paths
    assert "third_party/safe.rs" in paths
    assert "third_party/bad.rs" not in paths
    assert "generated/special.rs" not in paths
    assert "AGENTS.md" not in paths
    assert manifest["totals"]["rejected"]["disallowed_spdx"] == 2
    assert manifest["totals"]["rejected"]["denied_filename"] == 1

    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    assert validate_manifest(manifest_path, root=root) == manifest


def test_rust_manifest_detects_metadata_drift(tmp_path):
    root = tmp_path / "rust"
    root.mkdir()
    _write_tree(root)
    manifest = build_rust_manifest(root, source_revision="abc123")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)

    metadata_path = root / "license-metadata.json"
    metadata_path.write_text(
        json.dumps({"files": {"type": "root", "children": []}}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="license evidence hash mismatch"):
        validate_manifest(manifest_path, root=root)


def test_rust_metadata_rejects_conflicting_rules():
    metadata = _metadata()
    metadata["files"]["children"][0]["children"].append(
        {
            "type": "file",
            "name": "third_party/safe.rs",
            "license": {"spdx": "Apache-2.0", "copyright": ["Other"]},
        }
    )
    with pytest.raises(ValueError, match="conflicting file rules"):
        build_rules(metadata)


def test_rust_metadata_rejects_path_escape():
    metadata = _metadata()
    metadata["files"]["children"][0]["children"].append(
        {
            "type": "file",
            "name": "../escape.rs",
            "license": {"spdx": "MIT", "copyright": ["Fixture"]},
        }
    )
    with pytest.raises(ValueError, match="escapes root"):
        build_rules(metadata)
