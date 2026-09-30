"""Parse CPython's committed source SBOM as a third-party exclusion set."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath


CPYTHON_LICENSE_EVIDENCE_KIND = "cpython-root-license-sbom-v1"
CPYTHON_DECLARED_SPDX = "Python-2.0.1"


def _safe_relative(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("CPython SBOM file path is invalid")
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"CPython SBOM path escapes root: {value!r}")
    result = path.as_posix()
    if result in {"", "."}:
        raise ValueError("CPython SBOM file path is invalid")
    return result


def _normalized_sbom_sha256(path: Path) -> str:
    data = path.read_bytes()
    if b"\x00" not in data:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def load_exclusions(
    sbom_path: str | Path,
    *,
    root: str | Path | None = None,
) -> dict[str, str]:
    with Path(sbom_path).open(encoding="utf-8") as stream:
        sbom = json.load(stream)
    if not isinstance(sbom, dict) or sbom.get("spdxVersion") != "SPDX-2.3":
        raise ValueError("unsupported CPython source SBOM")
    files = sbom.get("files")
    if not isinstance(files, list):
        raise ValueError("CPython source SBOM has no files list")

    exclusions: dict[str, str] = {}
    for record in files:
        if not isinstance(record, dict):
            raise ValueError("CPython source SBOM file record is invalid")
        relative = _safe_relative(record.get("fileName"))
        checksums = record.get("checksums")
        if not isinstance(checksums, list):
            raise ValueError(f"CPython SBOM {relative!r} has no checksums")
        sha256_values = [
            item.get("checksumValue")
            for item in checksums
            if isinstance(item, dict) and item.get("algorithm") == "SHA256"
        ]
        if len(sha256_values) != 1:
            raise ValueError(
                f"CPython SBOM {relative!r} requires exactly one SHA256 checksum"
            )
        digest = sha256_values[0]
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or digest.lower() != digest
        ):
            raise ValueError(f"CPython SBOM {relative!r} SHA256 is invalid")
        try:
            bytes.fromhex(digest)
        except ValueError as exc:
            raise ValueError(
                f"CPython SBOM {relative!r} SHA256 is invalid"
            ) from exc
        if relative in exclusions and exclusions[relative] != digest:
            raise ValueError(f"CPython SBOM duplicate path conflicts: {relative!r}")
        exclusions[relative] = digest

    if root is not None:
        tree = Path(root).resolve()
        for relative, expected in exclusions.items():
            raw_path = tree / relative
            if raw_path.is_symlink():
                raise ValueError(f"CPython SBOM third-party file is a symlink: {relative}")
            path = raw_path.resolve()
            if tree not in path.parents or not path.is_file():
                raise ValueError(f"CPython SBOM third-party file is missing: {relative}")
            observed = _normalized_sbom_sha256(path)
            if observed != expected:
                raise ValueError(
                    f"CPython SBOM third-party checksum mismatch: {relative}"
                )
    return dict(sorted(exclusions.items()))
