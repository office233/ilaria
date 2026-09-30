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
) -> subprocess.CompletedProcess:
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
        timeout=180,
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

    try:
        _run_git(["init", "--quiet"], cwd=target, runner=runner)
        _run_git(
            ["remote", "add", "origin", record["url"]],
            cwd=target,
            runner=runner,
        )
        _run_git(
            ["fetch", "--quiet", "--depth", "1", "origin", record["commit"]],
            cwd=target,
            runner=runner,
        )
        _run_git(
            ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
            cwd=target,
            runner=runner,
        )
        head = _run_git(["rev-parse", "HEAD"], cwd=target, runner=runner).stdout.strip()
        remote = _run_git(
            ["remote", "get-url", "origin"], cwd=target, runner=runner
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
        return {
            "source_name": source_name,
            "url": record["url"],
            "ref": record["ref"],
            "commit": record["commit"],
            "destination": str(target),
            "submodules_present": submodules,
        }
    except Exception:
        # Never leave a partial checkout looking production-ready.
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    report = checkout_locked_source(
        args.lock,
        source_name=args.source,
        destination=args.out,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
