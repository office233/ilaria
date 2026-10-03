#!/usr/bin/env python3
"""Run every Python test suite of the Nexus checkout in isolated pytest sessions.

A single ``pytest`` invocation from the repository root is not how the suites
are owned or run:

* ``ilaria/forge`` tests import the top-level package ``forge``; CI runs them as
  ``python -m pytest -q forge`` from ``ilaria/``.
* Several frozen ``ramasite/benchmarks/ilaria/<gate>/`` deliverables reuse the module names
  ``gate.py`` / ``test_gate.py`` and import them as top-level modules, so two of
  them cannot share one interpreter session ("import file mismatch").
* ``bench/p2p_quality_adversarial`` needs ``ILARIA_CANONICAL_ROOT``; it defaults
  here to this checkout root, exactly as the P2P owner gates set it.

This runner executes one isolated session per suite with the owners' working
directory and environment.

Usage::

    python ramasite/scripts/run-python-tests.py                 # every suite
    python ramasite/scripts/run-python-tests.py --list
    python ramasite/scripts/run-python-tests.py --only forge --only bench/brev
    python ramasite/scripts/run-python-tests.py --python <python-path> -- -x

Exit status is 0 only when every selected suite passes or collects no tests.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ILARIA = ROOT / "ilaria"
BENCHMARKS = ROOT / "ramasite" / "benchmarks" / "ilaria"
IGNORED_PARTS = {"data", "node_modules", "__pycache__"}
NO_TESTS_COLLECTED = 5
SUMMARY = re.compile(r"\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed)|no tests ran")


def _ignored(parts) -> bool:
    return any(part in IGNORED_PARTS or part.startswith(".") or part.endswith("venv") for part in parts)


def _has_tests(directory: Path) -> bool:
    for path in directory.rglob("test_*.py"):
        if not _ignored(path.relative_to(directory).parts[:-1]):
            return True
    return False


def discover():
    """Return ``(name, working directory, pytest arguments)`` for every suite."""
    suites = []
    if (ILARIA / "forge").is_dir() and _has_tests(ILARIA / "forge"):
        suites.append(("ilaria/forge", ILARIA, ["forge"]))
    for group in sorted(p for p in ILARIA.iterdir() if p.is_dir() and p.name != "forge" and not _ignored((p.name,))):
        loose = sorted(p.name for p in group.glob("test_*.py"))
        if loose:
            suites.append((f"ilaria/{group.name}", ILARIA, [f"{group.name}/{name}" for name in loose]))
        for sub in sorted(p for p in group.iterdir() if p.is_dir() and not _ignored((p.name,))):
            if _has_tests(sub):
                suites.append((f"ilaria/{group.name}/{sub.name}", ILARIA, [f"{group.name}/{sub.name}"]))
    if BENCHMARKS.is_dir():
        loose = sorted(BENCHMARKS.glob("test_*.py"))
        if loose:
            suites.append(("bench", ILARIA, [str(path) for path in loose]))
        for directory in sorted(path for path in BENCHMARKS.iterdir() if path.is_dir() and not _ignored((path.name,))):
            if _has_tests(directory):
                suites.append((f"bench/{directory.name}", ILARIA, [str(directory)]))
    if any((ROOT / "ramasite" / "scripts").glob("test_*.py")):
        suites.append(("scripts", ROOT, ["ramasite/scripts"]))
    return suites


def run_suite(python, cwd, args, timeout, extra):
    env = dict(os.environ)
    env.setdefault("ILARIA_CANONICAL_ROOT", str(ROOT))
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    command = [python, "-m", "pytest", "-q", "-p", "no:cacheprovider", *args, *extra]
    started = time.monotonic()
    try:
        process = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=timeout)
        code, output = process.returncode, process.stdout + process.stderr
    except subprocess.TimeoutExpired as exc:
        partial = exc.stdout if isinstance(exc.stdout, str) else ""
        code, output = None, partial + f"\n[timed out after {timeout}s]"
    return code, output, time.monotonic() - started


def _summary(output: str) -> str:
    lines = [line.strip(" =") for line in output.splitlines() if SUMMARY.search(line)]
    return lines[-1] if lines else "no pytest summary"


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Run the Nexus Python test suites in isolated pytest sessions.")
    parser.add_argument("--python", default=sys.executable, help="interpreter used for every suite")
    parser.add_argument("--only", action="append", default=[], metavar="TEXT",
                        help="run only suites whose name contains TEXT (repeatable)")
    parser.add_argument("--list", action="store_true", help="list the suites and exit")
    parser.add_argument("--timeout", type=int, default=1800, help="seconds allowed per suite (default 1800)")
    parser.add_argument("pytest_args", nargs=argparse.REMAINDER, help="extra pytest arguments after --")
    options = parser.parse_args(argv)
    extra = options.pytest_args[1:] if options.pytest_args[:1] == ["--"] else options.pytest_args
    selected = [s for s in discover() if not options.only or any(text in s[0] for text in options.only)]
    if options.list:
        for name, cwd, args in selected:
            print(f"{name}\t(cwd {cwd.relative_to(ROOT) if cwd != ROOT else '.'}; pytest {' '.join(args)})")
        return 0
    if not selected:
        print("no suite matches the selection", file=sys.stderr)
        return 2
    failed = []
    for name, cwd, args in selected:
        code, output, seconds = run_suite(options.python, cwd, args, options.timeout, extra)
        passed = code in (0, NO_TESTS_COLLECTED)
        print(f"{'PASS' if passed else 'FAIL'} {name} ({seconds:.1f}s): {_summary(output)}", flush=True)
        if not passed:
            failed.append(name)
            print("\n".join(output.splitlines()[-40:]), flush=True)
    print(f"{len(selected) - len(failed)}/{len(selected)} suites passed", flush=True)
    if failed:
        print("failed suites: " + ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
