"""Build a fail-closed Go corpus manifest from explicit root-LICENSE notices."""
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from .data_contract import atomic_write_json, canonical_json_sha256, sha256_file
    from .go_license_reference import (
        GO_DECLARED_SPDX,
        GO_LICENSE_EVIDENCE_KIND,
        has_go_root_license_reference,
    )
    from .licensed_tree_source import (
        DEFAULT_ALLOWED_SPDX,
        DEFAULT_EXTENSIONS,
        DENY_FILENAMES,
        MANIFEST_FORMAT,
        SKIP_PARTS,
        inspect_file,
        spdx_expression_is_allowed,
    )
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, canonical_json_sha256, sha256_file
    from go_license_reference import (
        GO_DECLARED_SPDX,
        GO_LICENSE_EVIDENCE_KIND,
        has_go_root_license_reference,
    )
    from licensed_tree_source import (
        DEFAULT_ALLOWED_SPDX,
        DEFAULT_EXTENSIONS,
        DENY_FILENAMES,
        MANIFEST_FORMAT,
        SKIP_PARTS,
        inspect_file,
        spdx_expression_is_allowed,
    )


def _manifest_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("manifest_sha256", None)
    return canonical_json_sha256(payload)


def build_go_manifest(
    root: str | Path,
    *,
    source_revision: str,
    source_name: str = "golang_go",
    license_path: str = "LICENSE",
    allowed_spdx: set[str] | frozenset[str] = DEFAULT_ALLOWED_SPDX,
    extensions: set[str] | frozenset[str] = DEFAULT_EXTENSIONS,
) -> dict:
    tree = Path(root).resolve()
    if not tree.is_dir():
        raise ValueError(f"Go source root does not exist: {tree}")
    if not source_name.strip() or not source_revision.strip():
        raise ValueError("Go licensed tree requires source identity and revision")
    if not spdx_expression_is_allowed(GO_DECLARED_SPDX, allowed_spdx):
        raise ValueError("Go declared SPDX is not allowlisted")

    raw_license = tree / license_path
    if raw_license.is_symlink():
        raise ValueError("Go root LICENSE cannot be a symlink")
    root_license = raw_license.resolve()
    if tree not in root_license.parents or not root_license.is_file():
        raise ValueError("Go root LICENSE path is invalid")

    records: list[dict] = []
    rejected = {
        "no_root_license_reference": 0,
        "extension": 0,
        "denied_filename": 0,
        "secret_marker": 0,
        "symlink": 0,
    }
    for path in sorted(tree.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_symlink():
            rejected["symlink"] += 1
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(tree)
        if any(part in SKIP_PARTS for part in relative.parts):
            continue
        if path.name in DENY_FILENAMES:
            rejected["denied_filename"] += 1
            continue
        if path.suffix.lower() not in extensions:
            rejected["extension"] += 1
            continue
        if not has_go_root_license_reference(path):
            rejected["no_root_license_reference"] += 1
            continue
        size = path.stat().st_size
        if size <= 0:
            continue
        digest, has_secret = inspect_file(path)
        if has_secret:
            rejected["secret_marker"] += 1
            continue
        records.append(
            {
                "path": relative.as_posix(),
                "sha256": digest,
                "bytes": size,
                "spdx": GO_DECLARED_SPDX,
            }
        )

    if not records:
        raise ValueError("Go licensed tree contains no files with root-LICENSE references")
    manifest = {
        "format": MANIFEST_FORMAT,
        "source_name": source_name,
        "source_revision": source_revision,
        "allowed_spdx": sorted(allowed_spdx),
        "license_evidence": {
            "kind": GO_LICENSE_EVIDENCE_KIND,
            "path": Path(license_path).as_posix(),
            "sha256": sha256_file(root_license),
            "spdx": GO_DECLARED_SPDX,
            "file_notice": "go-root-license-reference-v1",
        },
        "files": records,
        "totals": {
            "files": len(records),
            "bytes": sum(record["bytes"] for record in records),
            "by_license": {GO_DECLARED_SPDX: len(records)},
            "rejected": rejected,
        },
    }
    manifest["manifest_sha256"] = _manifest_hash(manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-name", default="golang_go")
    parser.add_argument("--license", default="LICENSE")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    manifest = build_go_manifest(
        args.root,
        source_revision=args.source_revision,
        source_name=args.source_name,
        license_path=args.license,
    )
    atomic_write_json(args.out, manifest)
    print(
        f"[go-licensed-tree] files={manifest['totals']['files']} "
        f"bytes={manifest['totals']['bytes']} -> {args.out}"
    )
    print(f"[go-licensed-tree] sha256 {manifest['manifest_sha256']}")


if __name__ == "__main__":
    main()
