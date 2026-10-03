"""Build a CPython candidate manifest using root LICENSE plus committed SBOM."""
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from .cpython_sbom import (
        CPYTHON_DECLARED_SPDX,
        CPYTHON_LICENSE_EVIDENCE_KIND,
        load_exclusions,
    )
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
except ImportError:  # direct script execution
    from cpython_sbom import (
        CPYTHON_DECLARED_SPDX,
        CPYTHON_LICENSE_EVIDENCE_KIND,
        load_exclusions,
    )
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


def _manifest_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("manifest_sha256", None)
    return canonical_json_sha256(payload)


def _evidence_file(tree: Path, relative: str, *, label: str) -> Path:
    raw = tree / relative
    if raw.is_symlink():
        raise ValueError(f"CPython {label} cannot be a symlink")
    resolved = raw.resolve()
    if tree not in resolved.parents or not resolved.is_file():
        raise ValueError(f"CPython {label} path is invalid")
    return resolved


def build_cpython_manifest(
    root: str | Path,
    *,
    source_revision: str,
    source_name: str = "python_cpython",
    license_path: str = "LICENSE",
    sbom_path: str = "Misc/sbom.spdx.json",
    allowed_spdx: set[str] | frozenset[str] = DEFAULT_ALLOWED_SPDX,
    extensions: set[str] | frozenset[str] = DEFAULT_EXTENSIONS,
) -> dict:
    tree = Path(root).resolve()
    if not tree.is_dir():
        raise ValueError(f"CPython source root does not exist: {tree}")
    if not source_name.strip() or not source_revision.strip():
        raise ValueError("CPython licensed tree requires source identity and revision")
    if not spdx_expression_is_allowed(CPYTHON_DECLARED_SPDX, allowed_spdx):
        raise ValueError("CPython declared SPDX is not allowlisted")

    root_license = _evidence_file(tree, license_path, label="root LICENSE")
    source_sbom = _evidence_file(tree, sbom_path, label="source SBOM")
    exclusions = load_exclusions(source_sbom, root=tree)

    records: list[dict] = []
    rejected = {
        "third_party_sbom": 0,
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
        relative_posix = relative.as_posix()
        if relative_posix in exclusions:
            rejected["third_party_sbom"] += 1
            continue
        if path.name in DENY_FILENAMES:
            rejected["denied_filename"] += 1
            continue
        if path.suffix.lower() not in extensions:
            rejected["extension"] += 1
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
                "spdx": CPYTHON_DECLARED_SPDX,
            }
        )

    if not records:
        raise ValueError("CPython licensed tree produced no candidate files")
    manifest = {
        "format": MANIFEST_FORMAT,
        "source_name": source_name,
        "source_revision": source_revision,
        "allowed_spdx": sorted(allowed_spdx),
        "license_evidence": {
            "kind": CPYTHON_LICENSE_EVIDENCE_KIND,
            "path": Path(license_path).as_posix(),
            "sha256": sha256_file(root_license),
            "spdx": CPYTHON_DECLARED_SPDX,
            "sbom_path": Path(sbom_path).as_posix(),
            "sbom_sha256": sha256_file(source_sbom),
            "policy": "exclude-every-committed-source-sbom-file-v1",
        },
        "files": records,
        "totals": {
            "files": len(records),
            "bytes": sum(record["bytes"] for record in records),
            "by_license": {CPYTHON_DECLARED_SPDX: len(records)},
            "rejected": rejected,
            "sbom_exclusions": len(exclusions),
        },
    }
    manifest["manifest_sha256"] = _manifest_hash(manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-name", default="python_cpython")
    parser.add_argument("--license", default="LICENSE")
    parser.add_argument("--sbom", default="Misc/sbom.spdx.json")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    manifest = build_cpython_manifest(
        args.root,
        source_revision=args.source_revision,
        source_name=args.source_name,
        license_path=args.license,
        sbom_path=args.sbom,
    )
    atomic_write_json(args.out, manifest)
    print(
        f"[cpython-licensed-tree] files={manifest['totals']['files']} "
        f"bytes={manifest['totals']['bytes']} -> {args.out}"
    )
    print(f"[cpython-licensed-tree] sha256 {manifest['manifest_sha256']}")


if __name__ == "__main__":
    main()
