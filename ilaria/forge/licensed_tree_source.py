"""Build an auditable text/code corpus candidate from per-file SPDX licenses."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

try:
    from .data_contract import atomic_write_json, canonical_json_sha256, sha256_file
except ImportError:  # direct script execution
    from data_contract import atomic_write_json, canonical_json_sha256, sha256_file

MANIFEST_FORMAT = "ilaria-licensed-tree-source-v1"
DEFAULT_ALLOWED_SPDX = frozenset(
    {
        "0BSD",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "CC0-1.0",
        "ISC",
        "MIT",
        "Python-2.0.1",
    }
)
DEFAULT_EXTENSIONS = frozenset(
    {
        ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp",
        ".go", ".rs", ".py", ".js", ".ts", ".tsx", ".java",
        ".swift", ".kt", ".kts", ".sh", ".ps1", ".md", ".rst",
        ".txt", ".adoc", ".toml", ".yaml", ".yml", ".json",
    }
)
SKIP_PARTS = frozenset(
    {
        ".git", ".hg", ".svn", ".github", "node_modules", "vendor", "dist", "build",
        "__pycache__", ".venv", "venv", "target",
    }
)
DENY_FILENAMES = frozenset(
    {
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
        "CODEX.md",
        ".cursorrules",
        "copilot-instructions.md",
    }
)
_SPDX_MARKER = "SPDX-License-Identifier:"
_SPDX_ID = re.compile(r"^[A-Za-z0-9.+-]+$")
_SPDX_OPERATORS = {"AND", "OR"}
_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
)


def _manifest_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("manifest_sha256", None)
    return canonical_json_sha256(payload)


def detect_spdx(path: Path, *, max_bytes: int = 64 * 1024) -> str | None:
    with path.open("rb") as stream:
        raw = stream.read(max_bytes)
    # All markers inspected here are ASCII. Latin-1 preserves every input byte
    # one-to-one, so malformed UTF-8 cannot disappear during provenance checks.
    text = raw.decode("latin-1")
    expressions: list[str] = []
    for line in text.splitlines():
        if _SPDX_MARKER not in line:
            continue
        expression = line.split(_SPDX_MARKER, 1)[1].strip()
        if expression.endswith("*/"):
            expression = expression[:-2].rstrip()
        if expression:
            expressions.append(expression)
    if not expressions:
        return None
    unique = sorted(set(expressions))
    if len(unique) != 1:
        raise ValueError(f"ambiguous SPDX expressions: {unique}")
    return unique[0]


def spdx_expression_is_allowed(
    expression: str,
    allowed_spdx: set[str] | frozenset[str],
) -> bool:
    """Conservatively accept only simple AND/OR expressions of allowlisted IDs.

    Parentheses and WITH exceptions are rejected until explicitly modeled. For
    OR expressions every branch must be allowlisted; this is intentionally more
    conservative than SPDX semantics so a mixed permissive/restrictive choice
    cannot enter the production corpus accidentally.
    """
    if not isinstance(expression, str) or not expression.strip():
        return False
    tokens = expression.split()
    if not tokens:
        return False
    expect_id = True
    for token in tokens:
        if expect_id:
            if token in _SPDX_OPERATORS or token == "WITH":
                return False
            if not _SPDX_ID.fullmatch(token) or token not in allowed_spdx:
                return False
        else:
            if token not in _SPDX_OPERATORS:
                return False
        expect_id = not expect_id
    return not expect_id


def contains_strong_secret_marker(path: Path, *, max_bytes: int = 512 * 1024) -> bool:
    with path.open("rb") as stream:
        raw = stream.read(max_bytes)
    text = raw.decode("latin-1")
    return any(pattern.search(text) is not None for pattern in _SECRET_PATTERNS)


def inspect_file(
    path: Path,
    *,
    max_secret_bytes: int = 512 * 1024,
) -> tuple[str, bool]:
    """Hash a file and inspect its prefix for secrets in one filesystem pass."""
    digest = hashlib.sha256()
    prefix = bytearray()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
            if len(prefix) < max_secret_bytes:
                remaining = max_secret_bytes - len(prefix)
                prefix.extend(chunk[:remaining])
    text = bytes(prefix).decode("latin-1")
    has_secret = any(pattern.search(text) is not None for pattern in _SECRET_PATTERNS)
    return digest.hexdigest(), has_secret


def build_manifest(
    root: str | Path,
    *,
    source_name: str,
    source_revision: str,
    allowed_spdx: set[str] | frozenset[str] = DEFAULT_ALLOWED_SPDX,
    extensions: set[str] | frozenset[str] = DEFAULT_EXTENSIONS,
) -> dict:
    tree = Path(root).resolve()
    if not tree.is_dir():
        raise ValueError(f"licensed tree root does not exist: {tree}")
    if not source_name.strip() or not source_revision.strip():
        raise ValueError("licensed tree requires source_name and source_revision")
    if not allowed_spdx:
        raise ValueError("licensed tree requires a non-empty SPDX allowlist")

    records: list[dict] = []
    rejected = {
        "no_spdx": 0,
        "invalid_spdx": 0,
        "disallowed_spdx": 0,
        "extension": 0,
        "denied_filename": 0,
        "secret_marker": 0,
        "symlink": 0,
    }
    for path in sorted(tree.rglob("*"), key=lambda p: p.as_posix()):
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
        try:
            license_id = detect_spdx(path)
        except ValueError:
            rejected["invalid_spdx"] += 1
            continue
        if license_id is None:
            rejected["no_spdx"] += 1
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
                "path": relative.as_posix(),
                "sha256": digest,
                "bytes": size,
                "spdx": license_id,
            }
        )
    if not records:
        raise ValueError("licensed tree contains no allowlisted SPDX files")

    by_license: dict[str, int] = {}
    for record in records:
        by_license[record["spdx"]] = by_license.get(record["spdx"], 0) + 1
    manifest = {
        "format": MANIFEST_FORMAT,
        "source_name": source_name,
        "source_revision": source_revision,
        "allowed_spdx": sorted(allowed_spdx),
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


def validate_manifest(path: str | Path, *, root: str | Path) -> dict:
    manifest_path = Path(path)
    with manifest_path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict) or manifest.get("format") != MANIFEST_FORMAT:
        raise ValueError("unsupported licensed-tree manifest format")
    declared = manifest.get("manifest_sha256")
    if not isinstance(declared, str) or _manifest_hash(manifest) != declared:
        raise ValueError("licensed-tree manifest identity hash mismatch")
    tree = Path(root).resolve()
    allowed = set(manifest.get("allowed_spdx", []))
    license_evidence = manifest.get("license_evidence")
    metadata_rules = None
    go_license_reference = False
    cpython_exclusions = None
    if license_evidence is not None:
        if not isinstance(license_evidence, dict):
            raise ValueError("licensed-tree license evidence is invalid")
        try:
            from .cpython_sbom import (
                CPYTHON_DECLARED_SPDX,
                CPYTHON_LICENSE_EVIDENCE_KIND,
                load_exclusions as load_cpython_exclusions,
            )
        except ImportError:
            from cpython_sbom import (
                CPYTHON_DECLARED_SPDX,
                CPYTHON_LICENSE_EVIDENCE_KIND,
                load_exclusions as load_cpython_exclusions,
            )
        try:
            from .go_license_reference import (
                GO_DECLARED_SPDX,
                GO_LICENSE_EVIDENCE_KIND,
                has_go_root_license_reference,
            )
        except ImportError:
            from go_license_reference import (
                GO_DECLARED_SPDX,
                GO_LICENSE_EVIDENCE_KIND,
                has_go_root_license_reference,
            )
        try:
            from .rust_license_metadata import (
                RUST_LICENSE_EVIDENCE_KIND,
                load_rules,
                resolve_spdx,
            )
        except ImportError:
            from rust_license_metadata import (
                RUST_LICENSE_EVIDENCE_KIND,
                load_rules,
                resolve_spdx,
            )
        evidence_kind = license_evidence.get("kind")
        if evidence_kind not in {
            RUST_LICENSE_EVIDENCE_KIND,
            GO_LICENSE_EVIDENCE_KIND,
            CPYTHON_LICENSE_EVIDENCE_KIND,
        }:
            raise ValueError(
                "unsupported licensed-tree external license evidence kind"
            )
        evidence_relative = license_evidence.get("path")
        if not isinstance(evidence_relative, str) or not evidence_relative:
            raise ValueError("licensed-tree license evidence path is invalid")
        raw_evidence_path = tree / evidence_relative
        if raw_evidence_path.is_symlink():
            raise ValueError("licensed-tree license evidence cannot be a symlink")
        evidence_path = raw_evidence_path.resolve()
        if tree not in evidence_path.parents or not evidence_path.is_file():
            raise ValueError("licensed-tree license evidence path is invalid")
        evidence_sha256 = license_evidence.get("sha256")
        if sha256_file(evidence_path) != evidence_sha256:
            raise ValueError("licensed-tree license evidence hash mismatch")
        if evidence_kind == RUST_LICENSE_EVIDENCE_KIND:
            metadata_rules = load_rules(evidence_path)
        elif evidence_kind == GO_LICENSE_EVIDENCE_KIND:
            if license_evidence.get("spdx") != GO_DECLARED_SPDX:
                raise ValueError("licensed-tree Go license evidence SPDX drifted")
            if not spdx_expression_is_allowed(GO_DECLARED_SPDX, allowed):
                raise ValueError("licensed-tree Go license evidence is not allowlisted")
            go_license_reference = True
        else:
            if license_evidence.get("spdx") != CPYTHON_DECLARED_SPDX:
                raise ValueError("licensed-tree CPython license evidence SPDX drifted")
            if not spdx_expression_is_allowed(CPYTHON_DECLARED_SPDX, allowed):
                raise ValueError(
                    "licensed-tree CPython license evidence is not allowlisted"
                )
            sbom_relative = license_evidence.get("sbom_path")
            if not isinstance(sbom_relative, str) or not sbom_relative:
                raise ValueError("licensed-tree CPython SBOM path is invalid")
            raw_sbom = tree / sbom_relative
            if raw_sbom.is_symlink():
                raise ValueError("licensed-tree CPython SBOM cannot be a symlink")
            sbom_path = raw_sbom.resolve()
            if tree not in sbom_path.parents or not sbom_path.is_file():
                raise ValueError("licensed-tree CPython SBOM path is invalid")
            if sha256_file(sbom_path) != license_evidence.get("sbom_sha256"):
                raise ValueError("licensed-tree CPython SBOM hash mismatch")
            cpython_exclusions = load_cpython_exclusions(sbom_path, root=tree)
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("licensed-tree manifest has no files")
    observed_bytes = 0
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("licensed-tree file record is invalid")
        relative = record.get("path")
        license_id = record.get("spdx")
        if not isinstance(relative, str) or not relative:
            raise ValueError("licensed-tree file path is invalid")
        if not spdx_expression_is_allowed(str(license_id), allowed):
            raise ValueError(f"licensed-tree SPDX is not allowlisted: {license_id!r}")
        file_path = (tree / relative).resolve()
        if tree not in file_path.parents:
            raise ValueError("licensed-tree path escapes root")
        raw_file_path = tree / relative
        if raw_file_path.is_symlink():
            raise ValueError(f"licensed-tree symlink is forbidden: {relative}")
        if not file_path.is_file():
            raise ValueError(f"licensed-tree file is missing: {relative}")
        if file_path.name in DENY_FILENAMES:
            raise ValueError(f"licensed-tree denied filename: {relative}")
        size = file_path.stat().st_size
        if size != int(record.get("bytes", -1)):
            raise ValueError(f"licensed-tree size mismatch: {relative}")
        observed_hash, has_secret = inspect_file(file_path)
        if has_secret:
            raise ValueError(f"licensed-tree secret marker detected: {relative}")
        if observed_hash != record.get("sha256"):
            raise ValueError(f"licensed-tree hash mismatch: {relative}")
        if metadata_rules is not None:
            observed_spdx = resolve_spdx(relative, metadata_rules)
        elif go_license_reference:
            observed_spdx = (
                GO_DECLARED_SPDX
                if has_go_root_license_reference(file_path)
                else None
            )
        elif cpython_exclusions is not None:
            observed_spdx = (
                None
                if relative in cpython_exclusions
                else CPYTHON_DECLARED_SPDX
            )
        else:
            try:
                observed_spdx = detect_spdx(file_path)
            except ValueError as exc:
                raise ValueError(f"licensed-tree SPDX is ambiguous: {relative}") from exc
        if observed_spdx != license_id:
            raise ValueError(f"licensed-tree SPDX changed: {relative}")
        observed_bytes += size
    if observed_bytes != int(manifest.get("totals", {}).get("bytes", -1)):
        raise ValueError("licensed-tree byte total mismatch")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--root", required=True)
    build.add_argument("--source-name", required=True)
    build.add_argument("--source-revision", required=True)
    build.add_argument("--out", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--manifest", required=True)
    validate.add_argument("--root", required=True)
    args = parser.parse_args()
    if args.command == "build":
        manifest = build_manifest(
            args.root,
            source_name=args.source_name,
            source_revision=args.source_revision,
        )
        atomic_write_json(args.out, manifest)
        print(f"[licensed-tree] {args.out}: {manifest['manifest_sha256']}")
    else:
        manifest = validate_manifest(args.manifest, root=args.root)
        print(f"[licensed-tree] valid: {manifest['manifest_sha256']}")


if __name__ == "__main__":
    main()
