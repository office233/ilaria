#!/usr/bin/env python3
"""Supervisor v3 black-box integration harness.

The harness never grants authority itself. It drives the public Swyp,
plan-supervisor and evidence-check executables and emits one machine-readable
report. V3-only probes are enabled only when their public contracts are
available; unsupported host facilities are recorded explicitly rather than
treated as passing.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from typing import Any, Callable


REPORT_VERSION = 3
MAX_CAPTURE = 64 << 10


class ProbeSkip(RuntimeError):
    """A required external capability is unavailable in this environment."""


class ProbeFailure(RuntimeError):
    """A probe observed behavior that violates the expected contract."""


@dataclass
class Check:
    name: str
    status: str
    reason: str = ""
    duration_ns: int = 0
    evidence: dict[str, Any] = field(default_factory=dict)


class Harness:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.checks: list[Check] = []

    def run(self, name: str, probe: Callable[[], dict[str, Any] | None]) -> None:
        started = time.monotonic_ns()
        try:
            evidence = probe() or {}
        except ProbeSkip as error:
            self.checks.append(Check(name, "SKIP", str(error), time.monotonic_ns() - started))
        except Exception as error:
            self.checks.append(
                Check(name, "FAIL", f"{type(error).__name__}: {error}", time.monotonic_ns() - started)
            )
        else:
            self.checks.append(Check(name, "PASS", duration_ns=time.monotonic_ns() - started, evidence=evidence))

    @property
    def failed(self) -> bool:
        return any(check.status == "FAIL" for check in self.checks)

    @property
    def skipped(self) -> bool:
        return any(check.status == "SKIP" for check in self.checks)


def bounded(text: str) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_CAPTURE:
        return text
    return encoded[-MAX_CAPTURE:].decode("utf-8", errors="replace")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeFailure(message)


def require_executable(path: str) -> str:
    candidate = Path(path).resolve(strict=True)
    require(candidate.is_file(), f"not a file: {candidate}")
    return str(candidate)


def run_process(
    command: list[str],
    *,
    cwd: Path,
    timeout: float,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def baseline_v2_probe(args: argparse.Namespace) -> dict[str, Any]:
    """Re-run the established real three-product gate with this worker's binaries."""

    gate = Path(args.repo_root, "scripts", "verify-supervisor.py").resolve(strict=True)
    command = [
        sys.executable,
        str(gate),
        "--swyp",
        args.swyp,
        "--supervisor",
        args.supervisor,
        "--verifier",
        args.verifier,
    ]
    if sys.platform == "linux":
        if not args.cgroup_root:
            raise ProbeSkip("Linux baseline requires an explicitly delegated cgroup v2 root")
        command += ["--cgroup-root", args.cgroup_root]
    process = run_process(command, cwd=Path(args.repo_root), timeout=args.timeout)
    require(
        process.returncode == 0,
        f"v2 integration gate failed ({process.returncode}); stderr={bounded(process.stderr)!r}; "
        f"stdout={bounded(process.stdout)!r}",
    )
    require(
        "PASS: supervisor v2 integration gate" in process.stdout,
        "v2 gate did not emit its terminal PASS marker",
    )
    measurements: dict[str, Any] = {}
    for line in process.stdout.splitlines():
        for label in ("plan", "idle"):
            prefix = f"MEASURE supervisor {label}: "
            if line.startswith(prefix):
                try:
                    value = json.loads(line[len(prefix) :])
                except json.JSONDecodeError as error:
                    raise ProbeFailure(f"invalid {label} measurement JSON: {error}") from error
                require(isinstance(value, dict), f"{label} measurement is not an object")
                measurements[label] = value
    require("plan" in measurements, "v2 gate did not expose plan resource measurement")
    require(
        measurements["plan"].get("kernel_limit_mechanism") in {"windows_job_object", "linux_cgroup_v2"},
        "v2 gate did not prove an accepted kernel containment mechanism",
    )
    return {
        "exit_code": process.returncode,
        "measurements": measurements,
        "stdout_tail": bounded(process.stdout)[-8192:],
        "stderr_tail": bounded(process.stderr)[-4096:],
    }


def pending(reason: str) -> Callable[[], dict[str, Any]]:
    def probe() -> dict[str, Any]:
        raise ProbeSkip(reason)

    return probe


CONTINUATION_PENDING = "awaiting Worker 1/2 COMPLETE handoff of final broker continuation/resume integration"
CACHE_PENDING = "awaiting Worker 3 COMPLETE handoff and Worker 2 CLI release for plan-cache integration"
ENERGY_PENDING = "awaiting Worker 4 COMPLETE handoff and Worker 2 CLI release for energy integration"


def report_for(args: argparse.Namespace, harness: Harness) -> dict[str, Any]:
    containment = "unavailable"
    for check in harness.checks:
        if check.name != "baseline_three_product_integration" or check.status != "PASS":
            continue
        measurements = check.evidence.get("measurements")
        if isinstance(measurements, dict):
            plan = measurements.get("plan")
            if isinstance(plan, dict) and isinstance(plan.get("kernel_limit_mechanism"), str):
                containment = plan["kernel_limit_mechanism"]
        break
    return {
        "version": REPORT_VERSION,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "logical_cpus": os.cpu_count(),
        },
        "artifacts_dir": str(Path(args.artifacts_dir).resolve()),
        "executables": {
            "swyp": args.swyp,
            "plan_supervisor": args.supervisor,
            "evidence_check": args.verifier,
        },
        "checks": [asdict(check) for check in harness.checks],
        "resources": {
            "containment": containment,
            "linux_cgroup_root": args.cgroup_root if sys.platform == "linux" else "",
            "energy": {
                "status": "unavailable",
                "scope": "",
                "value": None,
                "reason": "v3 energy integration has not been handed off",
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--swyp", required=True)
    parser.add_argument("--supervisor", required=True)
    parser.add_argument("--verifier", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    parser.add_argument("--cgroup-root", default=os.environ.get("NEXUS_TEST_CGROUP_ROOT", ""))
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--allow-skips", action="store_true")
    parser.add_argument("--json-output")
    args = parser.parse_args()

    args.repo_root = str(Path(args.repo_root).resolve(strict=True))
    args.swyp = require_executable(args.swyp)
    args.supervisor = require_executable(args.supervisor)
    args.verifier = require_executable(args.verifier)
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    args.artifacts_dir = str(artifacts)

    harness = Harness(args)
    harness.run("baseline_three_product_integration", lambda: baseline_v2_probe(args))
    for name in (
        "resume_matches_uninterrupted_result",
        "resolved_provider_effect_not_replayed",
        "continuation_payload_mutation_rejected",
        "continuation_module_change_rejected",
        "continuation_run_change_rejected",
        "continuation_policy_change_rejected",
        "continuation_fence_change_rejected",
        "continuation_missing_result_rejected",
        "continuation_missing_payload_rejected",
        "continuation_missing_independent_evidence_rejected",
    ):
        harness.run(name, pending(CONTINUATION_PENDING))
    for name in (
        "snapshot_cache_hit_avoids_recompile",
        "snapshot_cache_source_change_invalidates",
        "snapshot_cache_dependency_change_invalidates",
        "snapshot_cache_compiler_change_invalidates",
        "snapshot_cache_protocol_change_invalidates",
        "snapshot_cache_policy_change_invalidates",
        "snapshot_cache_corrupt_entry_rejected",
        "snapshot_cache_truncated_entry_rejected",
        "snapshot_cache_hostile_entry_rejected",
        "snapshot_cache_quota_and_eviction_bounded",
    ):
        harness.run(name, pending(CACHE_PENDING))
    for name in (
        "kernel_containment_preserved_during_v3",
        "cancellation_contains_descendants",
        "persistent_verifier_reused_during_v3",
        "idle_resource_use_bounded_during_v3",
    ):
        harness.run(name, pending(CONTINUATION_PENDING))
    harness.run("optional_energy_has_real_scope_or_unavailable", pending(ENERGY_PENDING))

    report = report_for(args, harness)
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    print(rendered)
    if args.json_output:
        Path(args.json_output).write_text(rendered + "\n", encoding="utf-8")
    if harness.failed:
        return 1
    if harness.skipped and not args.allow_skips:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
