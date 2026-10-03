from __future__ import annotations

import hashlib
import json

import pytest

from cpython_licensed_tree_source import build_cpython_manifest
from cpython_sbom import CPYTHON_DECLARED_SPDX, load_exclusions
from data_contract import atomic_write_json
from licensed_tree_source import validate_manifest


def _normalized_sha256(data: bytes) -> str:
    if b"\x00" not in data:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def _tree(root):
    (root / "Misc").mkdir()
    (root / "Python").mkdir()
    (root / "Modules").mkdir()
    (root / "LICENSE").write_text("PSF license fixture\n", encoding="utf-8")
    (root / "Python" / "core.c").write_text("int core;\n", encoding="utf-8")
    (root / "Modules" / "local.c").write_text("int local;\n", encoding="utf-8")
    third_party = b"int external;\r\n"
    (root / "Modules" / "external.c").write_bytes(third_party)
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "files": [
            {
                "SPDXID": "SPDXRef-FILE-external",
                "fileName": "Modules/external.c",
                "checksums": [
                    {
                        "algorithm": "SHA256",
                        "checksumValue": _normalized_sha256(third_party),
                    }
                ],
            }
        ],
        "packages": [],
        "relationships": [],
    }
    (root / "Misc" / "sbom.spdx.json").write_text(
        json.dumps(sbom, sort_keys=True), encoding="utf-8"
    )


def test_cpython_sbom_exclusions_verify_normalized_checksum(tmp_path):
    root = tmp_path / "cpython"
    root.mkdir()
    _tree(root)
    exclusions = load_exclusions(root / "Misc" / "sbom.spdx.json", root=root)
    assert exclusions == {
        "Modules/external.c": _normalized_sha256(b"int external;\r\n")
    }


def test_cpython_manifest_excludes_every_sbom_file(tmp_path):
    root = tmp_path / "cpython"
    root.mkdir()
    _tree(root)
    manifest = build_cpython_manifest(root, source_revision="abc123")
    paths = [record["path"] for record in manifest["files"]]
    assert "Python/core.c" in paths
    assert "Modules/local.c" in paths
    assert "Modules/external.c" not in paths
    assert manifest["totals"]["rejected"]["third_party_sbom"] == 1
    assert all(record["spdx"] == CPYTHON_DECLARED_SPDX for record in manifest["files"])

    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    assert validate_manifest(manifest_path, root=root) == manifest


def test_cpython_manifest_detects_sbom_drift(tmp_path):
    root = tmp_path / "cpython"
    root.mkdir()
    _tree(root)
    manifest = build_cpython_manifest(root, source_revision="abc123")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    (root / "Misc" / "sbom.spdx.json").write_text(
        json.dumps({"spdxVersion": "SPDX-2.3", "files": []}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="CPython SBOM hash mismatch"):
        validate_manifest(manifest_path, root=root)


def test_cpython_sbom_rejects_path_escape(tmp_path):
    sbom_path = tmp_path / "sbom.json"
    sbom_path.write_text(
        json.dumps(
            {
                "spdxVersion": "SPDX-2.3",
                "files": [
                    {
                        "fileName": "../escape.c",
                        "checksums": [
                            {"algorithm": "SHA256", "checksumValue": "0" * 64}
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="escapes root"):
        load_exclusions(sbom_path)


def test_cpython_sbom_detects_excluded_file_drift(tmp_path):
    root = tmp_path / "cpython"
    root.mkdir()
    _tree(root)
    manifest = build_cpython_manifest(root, source_revision="abc123")
    manifest_path = tmp_path / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    (root / "Modules" / "external.c").write_text("changed\n", encoding="utf-8")
    with pytest.raises(ValueError, match="third-party checksum mismatch"):
        validate_manifest(manifest_path, root=root)
