"""Immutable Git source locks for external technical corpus candidates."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from data_contract import atomic_write_json, canonical_json_sha256, require_lower_sha256

LOCK_FORMAT = "ilaria-git-source-lock-v1"
_SHA1 = re.compile(r"^[0-9a-f]{40}$")


def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("source_lock_sha256", None)
    return canonical_json_sha256(payload)


def _require_commit(name: str, value: str) -> str:
    if not isinstance(value, str) or not _SHA1.fullmatch(value):
        raise ValueError(f"{name} must be a lowercase 40-hex Git commit SHA")
    return value


def _require_https_url(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.startswith("https://"):
        raise ValueError(f"{name} must be an https URL")
    if any(ch.isspace() for ch in value):
        raise ValueError(f"{name} contains whitespace")
    return value


def build_lock(entries: dict[str, dict]) -> dict:
    if not entries:
        raise ValueError("git source lock requires at least one source")
    locked = {}
    for name in sorted(entries):
        record = entries[name]
        if not isinstance(record, dict):
            raise ValueError(f"git source {name!r} is invalid")
        url = _require_https_url(f"git source {name} url", record.get("url", ""))
        commit = _require_commit(
            f"git source {name} commit", record.get("commit", "")
        )
        ref = record.get("ref", "main")
        if not isinstance(ref, str) or not ref or any(ch.isspace() for ch in ref):
            raise ValueError(f"git source {name} ref is invalid")
        locked[name] = {"url": url, "ref": ref, "commit": commit}
    lock = {"format": LOCK_FORMAT, "sources": locked}
    lock["source_lock_sha256"] = _identity_hash(lock)
    return lock


def validate_lock(lock: dict) -> dict:
    if not isinstance(lock, dict) or lock.get("format") != LOCK_FORMAT:
        raise ValueError("unsupported git source lock format")
    declared = lock.get("source_lock_sha256", "")
    require_lower_sha256("source_lock_sha256", declared)
    if _identity_hash(lock) != declared:
        raise ValueError("git source lock identity hash mismatch")
    sources = lock.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("git source lock has no sources")
    build_lock(sources)
    return lock


def load_lock(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        return validate_lock(json.load(stream))


def resolve_remote(
    url: str,
    *,
    ref: str = "main",
    timeout_seconds: int = 60,
) -> str:
    _require_https_url("git remote url", url)
    if not isinstance(ref, str) or not ref or any(ch.isspace() for ch in ref):
        raise ValueError("git remote ref is invalid")
    if type(timeout_seconds) is not int or timeout_seconds < 1:
        raise ValueError("git remote timeout must be a positive integer")
    proc = subprocess.run(
        ["git", "ls-remote", url, f"refs/heads/{ref}"],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git ls-remote failed: {proc.stderr.strip()}")
    line = proc.stdout.strip().splitlines()
    if len(line) != 1:
        raise RuntimeError(f"git ref {ref!r} did not resolve uniquely")
    commit = line[0].split()[0]
    return _require_commit("resolved git commit", commit)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--source", action="append", required=True, help="NAME=HTTPS_URL[@REF]")
    resolve.add_argument("--timeout-seconds", type=int, default=60)
    resolve.add_argument("--out", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--lock", required=True)
    args = parser.parse_args()
    if args.command == "validate":
        lock = load_lock(args.lock)
        print(f"[git-source-lock] valid: {lock['source_lock_sha256']}")
        return
    entries = {}
    for raw in args.source:
        name, sep, target = raw.partition("=")
        if not sep or not name or not target:
            raise ValueError("--source must be NAME=HTTPS_URL[@REF]")
        url, at, ref = target.rpartition("@")
        if not at:
            url, ref = target, "main"
        entries[name] = {
            "url": url,
            "ref": ref,
            "commit": resolve_remote(
                url,
                ref=ref,
                timeout_seconds=args.timeout_seconds,
            ),
        }
    lock = build_lock(entries)
    atomic_write_json(args.out, lock)
    print(f"[git-source-lock] {args.out}: {lock['source_lock_sha256']}")


if __name__ == "__main__":
    main()
