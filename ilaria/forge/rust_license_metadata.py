"""Parse Rust's committed REUSE license metadata without executing repo code."""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath


RUST_LICENSE_EVIDENCE_KIND = "rust-license-metadata-v1"


def _relative_path(value: object, *, allow_dot: bool = False) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("Rust license metadata path is invalid")
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Rust license metadata path escapes root: {value!r}")
    cleaned = path.as_posix()
    if cleaned == ".":
        if allow_dot:
            return ""
        raise ValueError("Rust license metadata path cannot be '.' here")
    if cleaned.startswith("./"):
        cleaned = cleaned[2:]
    if not cleaned:
        raise ValueError("Rust license metadata path is empty")
    return cleaned


def _join(base: str, child: object, *, allow_dot: bool = False) -> str:
    relative = _relative_path(child, allow_dot=allow_dot)
    if not relative:
        return base
    return f"{base}/{relative}".strip("/")


def _license_spdx(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Rust license metadata license must be an object")
    spdx = value.get("spdx")
    if not isinstance(spdx, str) or not spdx.strip():
        raise ValueError("Rust license metadata has an invalid SPDX expression")
    return spdx.strip()


def _set_rule(rules: dict[str, str], path: str, spdx: str, *, kind: str) -> None:
    existing = rules.get(path)
    if existing is not None and existing != spdx:
        label = path or "."
        raise ValueError(
            f"Rust license metadata has conflicting {kind} rules for {label!r}: "
            f"{existing!r} != {spdx!r}"
        )
    rules[path] = spdx


def build_rules(metadata: dict) -> dict:
    """Flatten Rust's cached REUSE tree into deterministic file/directory rules."""
    if not isinstance(metadata, dict):
        raise ValueError("Rust license metadata must be a JSON object")
    root = metadata.get("files")
    if not isinstance(root, dict) or root.get("type") != "root":
        raise ValueError("Rust license metadata has no files root")

    directory_rules: dict[str, str] = {}
    file_rules: dict[str, str] = {}

    def visit(node: object, base: str, inherited_spdx: str | None) -> None:
        if not isinstance(node, dict):
            raise ValueError("Rust license metadata node must be an object")
        node_type = node.get("type")

        if node_type == "root":
            if node.get("license") is not None:
                raise ValueError("Rust license metadata root cannot declare a license")
            children = node.get("children")
            if not isinstance(children, list) or not children:
                raise ValueError("Rust license metadata root has no children")
            for child in children:
                visit(child, base, inherited_spdx)
            return

        explicit_spdx = _license_spdx(node.get("license"))
        effective_spdx = explicit_spdx or inherited_spdx

        if node_type == "directory":
            path = _join(base, node.get("name"), allow_dot=True)
            if effective_spdx is None:
                raise ValueError(
                    f"Rust license metadata directory {path or '.'!r} has no license"
                )
            if explicit_spdx is not None:
                _set_rule(directory_rules, path, explicit_spdx, kind="directory")
            children = node.get("children", [])
            if not isinstance(children, list):
                raise ValueError(
                    f"Rust license metadata directory {path or '.'!r} children are invalid"
                )
            for child in children:
                visit(child, path, effective_spdx)
            return

        if node_type == "file":
            path = _join(base, node.get("name"))
            if effective_spdx is None:
                raise ValueError(
                    f"Rust license metadata file {path!r} has no license"
                )
            if explicit_spdx is not None:
                _set_rule(file_rules, path, explicit_spdx, kind="file")
            return

        if node_type == "group":
            if explicit_spdx is None:
                raise ValueError("Rust license metadata group has no license")
            files = node.get("files", [])
            directories = node.get("directories", [])
            if not isinstance(files, list) or not isinstance(directories, list):
                raise ValueError("Rust license metadata group paths are invalid")
            if not files and not directories:
                raise ValueError("Rust license metadata group is empty")
            for filename in files:
                _set_rule(
                    file_rules,
                    _join(base, filename),
                    explicit_spdx,
                    kind="file",
                )
            for dirname in directories:
                _set_rule(
                    directory_rules,
                    _join(base, dirname),
                    explicit_spdx,
                    kind="directory",
                )
            return

        raise ValueError(f"Rust license metadata node type is invalid: {node_type!r}")

    visit(root, "", None)
    if "" not in directory_rules:
        raise ValueError("Rust license metadata does not define a repository-root license")
    return {
        "directories": dict(sorted(directory_rules.items())),
        "files": dict(sorted(file_rules.items())),
    }


def load_rules(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        metadata = json.load(stream)
    return build_rules(metadata)


def resolve_spdx(path: str, rules: dict) -> str | None:
    """Resolve one repository-relative path using most-specific metadata."""
    normalized = _relative_path(path)
    files = rules.get("files")
    directories = rules.get("directories")
    if not isinstance(files, dict) or not isinstance(directories, dict):
        raise ValueError("Rust license rules are invalid")
    exact = files.get(normalized)
    if exact is not None:
        return exact

    parts = PurePosixPath(normalized).parts
    for depth in range(len(parts) - 1, -1, -1):
        prefix = "/".join(parts[:depth])
        match = directories.get(prefix)
        if match is not None:
            return match
    return None
