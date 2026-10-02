"""Extract explicit code bundles into new workspaces without deleting user files."""
from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import stat
import zipfile

# Safety bounds on this code-bundle format, not training/runtime defaults.
MAX_BUNDLE_FILES = 10_000
MAX_BUNDLE_BYTES = 128 << 20
MAX_MEMBER_BYTES = 16 << 20


def extract_code_bundle(bundle: str | Path, workspace: str | Path) -> Path:
    """Validate all members before creating an exclusive, caller-chosen root.

    Existing workspaces (including symlinks) are always refused. Failure may leave
    this newly created workspace incomplete; it is never executed by the caller.
    No existing directory is recursively deleted or overwritten.
    """
    source = Path(bundle).resolve(strict=True)
    target = Path(workspace).absolute()
    if target.exists() or target.is_symlink():
        raise ValueError("workspace already exists; select a new directory")
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if not members or len(members) > MAX_BUNDLE_FILES:
            raise ValueError("code bundle has an invalid member count")
        seen: set[str] = set()
        files: set[str] = set()
        total = 0
        for member in members:
            # ZipInfo may normalize backslashes on Windows. Inspect the original
            # central-directory name before accepting the normalized spelling.
            raw = member.orig_filename.rstrip("/")
            path = PurePosixPath(raw)
            mode = member.external_attr >> 16
            if (not raw or raw.startswith("/") or "\\" in raw or ":" in raw
                    or any(ord(char) < 32 for char in raw)
                    or any(part in ("", ".", "..") or part.endswith((".", " "))
                           or PureWindowsPath(part).is_reserved()
                           for part in raw.split("/"))
                    or path.as_posix() != raw or (member.flag_bits & 1)
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError(f"unsafe code-bundle member: {member.filename!r}")
            # Case aliases are refused on every host, for portable bundles.
            key = raw.casefold()
            if key in seen:
                raise ValueError("duplicate or case-aliased code-bundle member")
            seen.add(key)
            if not member.is_dir():
                files.add(key)
            if member.file_size < 0 or member.file_size > MAX_MEMBER_BYTES:
                raise ValueError("code-bundle member exceeds its size limit")
            total += member.file_size
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("code bundle exceeds its expanded size limit")
        for key in seen:
            if any(parent.as_posix() in files for parent in PurePosixPath(key).parents if str(parent) != "."):
                raise ValueError("code-bundle file overlaps a directory")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir(exist_ok=False)
        for member in members:
            destination = target / member.filename
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as stream, destination.open("xb") as output:
                shutil.copyfileobj(stream, output, 1 << 20)
            if destination.stat().st_size != member.file_size:
                raise ValueError("code-bundle member size changed during extraction")
    return target
