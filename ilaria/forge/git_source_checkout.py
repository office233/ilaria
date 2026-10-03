"""Materialize an immutable Git source lock entry without executing repo code."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from git_source_lock import load_lock


def _run_git(
    args: list[str],
    *,
    cwd: Path | None = None,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    timeout_seconds: int = 1800,
) -> subprocess.CompletedProcess:
    if timeout_seconds < 1:
        raise ValueError("git command timeout must be positive")
    env = dict(os.environ)
    env.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "",
        }
    )
    proc = runner(
        ["git", "-c", "core.hooksPath=", *args],
        cwd=str(cwd) if cwd is not None else None,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout_seconds,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git command failed ({' '.join(args)}): {proc.stderr.strip()}"
        )
    return proc


def checkout_locked_source(
    lock_path: str | Path,
    *,
    source_name: str,
    destination: str | Path,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    command_timeout_seconds: int = 1800,
) -> dict:
    lock = load_lock(lock_path)
    record = lock["sources"].get(source_name)
    if not isinstance(record, dict):
        raise ValueError(f"git source lock has no entry for {source_name!r}")

    target = Path(destination).resolve()
    if target.exists():
        if not target.is_dir():
            raise ValueError(f"checkout destination is not a directory: {target}")
        if any(target.iterdir()):
            raise ValueError(f"checkout destination is not empty: {target}")
    else:
        target.mkdir(parents=True)

    complete = False
    try:
        _run_git(
            ["init", "--quiet"],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        )
        _run_git(
            ["remote", "add", "origin", record["url"]],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        )
        _run_git(
            ["fetch", "--quiet", "--depth", "1", "origin", record["commit"]],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        )
        _run_git(
            ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        )
        head = _run_git(
            ["rev-parse", "HEAD"],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        ).stdout.strip()
        remote = _run_git(
            ["remote", "get-url", "origin"],
            cwd=target,
            runner=runner,
            timeout_seconds=command_timeout_seconds,
        ).stdout.strip()
        if head != record["commit"]:
            raise ValueError(
                f"checked out commit differs from lock: {head} != {record['commit']}"
            )
        if remote != record["url"]:
            raise ValueError(
                f"checkout remote differs from lock: {remote!r} != {record['url']!r}"
            )
        gitmodules = target / ".gitmodules"
        if gitmodules.exists():
            # Submodules are never initialized implicitly. Their content requires
            # a separate lock/evidence record before it can enter a corpus.
            submodules = True
        else:
            submodules = False
        result = {
            "source_name": source_name,
            "url": record["url"],
            "ref": record["ref"],
            "commit": record["commit"],
            "destination": str(target),
            "submodules_present": submodules,
        }
        complete = True
        return result
    finally:
        # Never leave a partial checkout looking production-ready.
        if not complete and target.exists():
            shutil.rmtree(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    report = checkout_locked_source(
        args.lock,
        source_name=args.source,
        destination=args.out,
        command_timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
