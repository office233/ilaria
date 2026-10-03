#!/usr/bin/env python3
"""Reproducible supervisor v2 CPU/RAM/process-start/latency benchmark."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sys
import tempfile
import time


def load_gate_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "verify-supervisor.py"
    spec = importlib.util.spec_from_file_location("nexus_verify_supervisor", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load supervisor fixture")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        raise ValueError("empty sample")
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def distribution(values: list[int]) -> dict[str, int]:
    return {"min": min(values), "p50": percentile(values, 0.50),
            "p95": percentile(values, 0.95), "max": max(values)}


def wait_for_active_guest(gate, service, fixture, executable: str) -> None:
    deadline = time.monotonic() + 10
    ledger_directory = Path(fixture.config["ledger_directory"])
    while time.monotonic() < deadline:
        # The supervisor ledger is created only after compilation. Once it
        # exists, the next Swyp child is the guest, not the preflight compiler.
        durable = ledger_directory.exists() and any(ledger_directory.iterdir())
        if durable and gate.child_pids(service.process.pid, executable):
            return
        if service.process.poll() is not None:
            raise AssertionError("supervisor exited before active cancellation point")
        time.sleep(0.002)
    raise AssertionError("active guest did not start before cancellation deadline")


def cancel_active_service(service) -> int:
    started = time.monotonic_ns()
    service.send({"op": "shutdown"})
    service.process.stdin.close()
    assert service.process.wait(timeout=10) == 0, service.errors.decode("utf-8", errors="replace")
    latency = time.monotonic_ns() - started
    service.reader.join(timeout=2)
    service.stderr_reader.join(timeout=2)
    while not service.frames.empty():
        frame = service.frames.get_nowait()
        if isinstance(frame, EOFError):
            continue
        if isinstance(frame, Exception):
            raise AssertionError(str(frame))
        assert isinstance(frame, dict), frame
        status = frame.get("status")
        assert frame.get("error_code") and (status is None or status.get("state") != "SUCCEEDED"), frame
    return latency


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("swyp", "supervisor", "verifier"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--cgroup-root", default=os.environ.get("NEXUS_TEST_CGROUP_ROOT", ""))
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()
    if args.samples < 5:
        raise SystemExit("--samples must be >= 5")
    for option in ("swyp", "supervisor", "verifier"):
        value = Path(getattr(args, option)).resolve(strict=True)
        setattr(args, option, str(value))
    if sys.platform == "linux" and not args.cgroup_root:
        raise SystemExit("Linux benchmark requires an explicit delegated --cgroup-root")

    gate = load_gate_module()
    walls: list[int] = []
    cpus: list[int] = []
    rss: list[int] = []
    starts: list[int] = []
    shutdowns: list[int] = []
    cancellations: list[int] = []
    mechanism = ""
    with tempfile.TemporaryDirectory(prefix="nexus-supervisor-benchmark-") as raw_directory:
        directory = Path(raw_directory).resolve()
        for index in range(args.samples):
            fixture = gate.Fixture(args, directory, f"cold-{index:03d}")
            report = fixture.run(True)
            gate.successful(report, 3)
            metrics = report["metrics"]
            mechanism = metrics["kernel_limit_mechanism"]
            walls.append(int(metrics["wall_time_ns"]))
            cpus.append(int(metrics["host_cpu_time_ns"]) + int(metrics["swyp_cpu_time_ns"]) +
                        int(metrics["verifier_cpu_time_ns"]))
            rss.append(max(int(metrics["host_peak_rss_bytes"]), int(metrics["swyp_peak_rss_bytes"]),
                           int(metrics["verifier_peak_rss_bytes"])))
            starts.append(int(metrics["process_starts"]))

        for index in range(args.samples):
            fixture = gate.Fixture(args, directory, f"shutdown-{index:03d}")
            service = gate.Service(fixture)
            try:
                ready = service.frame()
                assert ready["type"] == "ready", ready
                service.send({"op": "run", "plan_id": fixture.config["plans"][0]["id"]})
                gate.successful(service.frame(), 3)
                started = time.monotonic_ns()
                service.shutdown()
                shutdowns.append(time.monotonic_ns() - started)
            finally:
                service.close()

        for index in range(args.samples):
            fixture = gate.Fixture(args, directory, f"cancel-{index:03d}")
            plan = fixture.config["plans"][0]
            Path(plan["source"]).write_text(
                "fn main() -> u64 { while true {} return 0; }\n", encoding="utf-8")
            plan.update({"scopes": [], "max_effects": 1, "max_read_bytes": 0,
                         "fuel": 1_000_000, "max_returned_bytes": 64,
                         "wall_time_ms": 10_000})
            service = gate.Service(fixture)
            try:
                ready = service.frame()
                assert ready["type"] == "ready", ready
                service.send({"op": "run", "plan_id": plan["id"]})
                wait_for_active_guest(gate, service, fixture, args.swyp)
                cancellations.append(cancel_active_service(service))
            finally:
                service.close()

    output = {
        "benchmark": "nexus-supervisor-v2",
        "sample_count": args.samples,
        "platform": {"system": platform.system(), "release": platform.release(),
                     "machine": platform.machine(), "python": platform.python_version(),
                     "logical_cpus": os.cpu_count()},
        "configuration": {"profile": "balanced", "device_class": "workstation",
                          "cpu_time_ms": 5000, "rss_limit_bytes": 128 << 20,
                          "kernel_cpu_percent": 8, "kernel_memory_limit_bytes": 192 << 20,
                          "kernel_max_processes": 16, "sample_interval_ms": 20,
                          "kernel_limit_mechanism": mechanism,
                          "linux_cgroup_root": args.cgroup_root if sys.platform == "linux" else ""},
        "cold_plan_wall_time_ns": distribution(walls),
        "cold_plan_total_cpu_time_ns": distribution(cpus),
        "cold_plan_peak_rss_bytes": distribution(rss),
        "cold_plan_process_starts": {"min": min(starts), "max": max(starts),
                                     "values_identical": len(set(starts)) == 1},
        "service_shutdown_latency_ns": distribution(shutdowns),
        "active_cancellation_latency_ns": distribution(cancellations),
        "energy": {"status": "unavailable", "reason": "no real energy counter configured"},
    }
    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
