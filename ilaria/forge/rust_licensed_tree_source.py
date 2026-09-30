"""Build a licensed-tree manifest from Rust's committed REUSE metadata."""
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from .data_contract import atomic_write_json, canonical_json_sha256, sha256_file
    from .licensed_tree_source import (
        DEFAULT_ALLOWED_SPDX,
        DEFAULT_EXTENSIONS,
        DENY_FILENAMES,
        MANIFEST_FORMAT,
        SKIP_PARTS,
        inspect_file,
        spdx_expression_is_allowed,
    )
    from .rust_license_metadata import (
        RUST_LICENSE_EVIDENCE_KIND,
        load_rules,
        resolve_spdx,
    )
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, canonical_json_sha256, sha256_file
    from licensed_tree_source import (
        DEFAULT_ALLOWED_SPDX,
        DEFAULT_EXTENSIONS,
        DENY_FILENAMES,
        MANIFEST_FORMAT,
        SKIP_PARTS,
        inspect_file,
        spdx_expression_is_allowed,
    )
    from rust_license_metadata import (
        RUST_LICENSE_EVIDENCE_KIND,
        load_rules,
        resolve_spdx,
    )


def _manifest_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("manifest_sha256", None)
    return canonical_json_sha256(payload)


def build_rust_manifest(
    root: str | Path,
    *,
    source_revision: str,
    source_name: str = "rust_lang",
    metadata_path: str = "license-metadata.json",
    allowed_spdx: set[str] | frozenset[str] = DEFAULT_ALLOWED_SPDX,
    extensions: set[str] | frozenset[str] = DEFAULT_EXTENSIONS,
) -> dict:
    tree = Path(root).resolve()
    if not tree.is_dir():
        raise ValueError(f"Rust source root does not exist: {tree}")
    if not source_name.strip() or not source_revision.strip():
        raise ValueError("Rust licensed tree requires source identity and revision")
    if not allowed_spdx:
        raise ValueError("Rust licensed tree requires a non-empty SPDX allowlist")

    metadata = (tree / metadata_path).resolve()
    if tree not in metadata.parents:
        raise ValueError("Rust license metadata path escapes source root")
    raw_metadata = tree / metadata_path
    if raw_metadata.is_symlink() or not metadata.is_file():
        raise ValueError("Rust license metadata is missing or is a symlink")
    rules = load_rules(metadata)

    records: list[dict] = []
    rejected = {
        "unmapped_license": 0,
        "disallowed_spdx": 0,
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
        relative_posix = relative.as_posix()
        license_id = resolve_spdx(relative_posix, rules)
        if license_id is None:
            rejected["unmapped_license"] += 1
            continue
        if not spdx_expression_is_allowed(license_id, allowed_spdx):
            rejected["disallowed_spdx"] += 1
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
                "path": relative_posix,
                "sha256": digest,
                "bytes": size,
                "spdx": license_id,
            }
        )

    if not records:
        raise ValueError("Rust licensed tree contains no allowlisted files")
    by_license: dict[str, int] = {}
    for record in records:
        by_license[record["spdx"]] = by_license.get(record["spdx"], 0) + 1

    manifest = {
        "format": MANIFEST_FORMAT,
        "source_name": source_name,
        "source_revision": source_revision,
        "allowed_spdx": sorted(allowed_spdx),
        "license_evidence": {
            "kind": RUST_LICENSE_EVIDENCE_KIND,
            "path": Path(metadata_path).as_posix(),
            "sha256": sha256_file(metadata),
        },
        "files": records,
        "totals": {
            "files": len(records),
            "bytes": sum(record["bytes"] for record in records),
            "by_license": dict(sorted(by_license.items())),
            "rejected": rejected,
        },
    }
    manifest["manifest_sha256"] = _manifest_hash(manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-name", default="rust_lang")
    parser.add_argument("--metadata", default="license-metadata.json")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    manifest = build_rust_manifest(
        args.root,
        source_revision=args.source_revision,
        source_name=args.source_name,
        metadata_path=args.metadata,
    )
    atomic_write_json(args.out, manifest)
    print(
        f"[rust-licensed-tree] files={manifest['totals']['files']} "
        f"bytes={manifest['totals']['bytes']} -> {args.out}"
    )
    print(f"[rust-licensed-tree] sha256 {manifest['manifest_sha256']}")


if __name__ == "__main__":
    main()
