"""Bounded, serial cross-language benchmark with retained evidence.

Builds only inside a NEW output directory. Never replaces bin/swyp.exe, installs
compilers, or calls models/services. Use --self-test to validate the result parser.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import shutil
import statistics
import subprocess
import sys
import time
import unittest
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def parse_output(output: str) -> dict[str, Any]:
    results = [line.split()[1:] for line in output.splitlines() if line.startswith("RESULT ")]
    weights = [line.split()[1:] for line in output.splitlines() if line.startswith("WEIGHTS ")]
    if len(results) != 1 or len(results[0]) != 2 or len(weights) > 1:
        raise ValueError("expected exactly one RESULT and at most one WEIGHTS line")
    seconds, value = map(float, results[0])
    if not math.isfinite(seconds) or seconds <= 0 or not math.isfinite(value):
        raise ValueError("invalid time or non-finite result")
    parsed_weights = list(map(float, weights[0])) if weights else None
    if parsed_weights is not None and (len(parsed_weights) != 3 or not all(map(math.isfinite, parsed_weights))):
        raise ValueError("expected three finite training values")
    return {"seconds": seconds, "value": value, "weights": parsed_weights}


def validate(row: dict[str, Any], oracle: dict[str, Any], mode: int) -> None:
    if mode in (0, 1):
        if row["value"] != oracle["value"]:
            raise ValueError("integer checksum/count mismatch")
    elif not math.isclose(row["value"], oracle["value"], rel_tol=1e-9, abs_tol=1e-15):
        raise ValueError("loss mismatch")
    if mode == 2:
        if row["weights"] is None or oracle["weights"] is None:
            raise ValueError("missing training parameters")
        if len(row["weights"]) != len(oracle["weights"]):
            raise ValueError("training parameter mismatch")
        for value, expected in zip(row["weights"], oracle["weights"], strict=True):
            if not math.isclose(value, expected, rel_tol=1e-9, abs_tol=1e-15):
                raise ValueError("training parameter mismatch")


class ParserTests(unittest.TestCase):
    def test_valid(self) -> None:
        self.assertEqual(parse_output("RESULT 0.1 42\n")["value"], 42)

    def test_invalid_records(self) -> None:
        for text in ("", "RESULT 1 2\nRESULT 1 2", "RESULT 0 2", "RESULT -1 2",
                     "RESULT nan 2", "RESULT 1 inf", "RESULT 1 2 3",
                     "WEIGHTS 1 2\nRESULT 1 2", "WEIGHTS 1 2 nan\nRESULT 1 2"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_output(text)

    def test_mismatch(self) -> None:
        with self.assertRaises(ValueError):
            validate(parse_output("RESULT 1 3"), parse_output("RESULT 1 2"), 1)

    def test_training(self) -> None:
        row = parse_output("WEIGHTS 2 1 0\nRESULT 1 0")
        validate(row, row, 2)
        with self.assertRaises(ValueError):
            validate(parse_output("RESULT 1 0"), row, 2)


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ParserTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True, choices=("mandelbrot", "primes", "train"))
    parser.add_argument("--size", type=int, required=True)
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--output", type=Path, required=True, help="New directory, must not exist")
    parser.add_argument("--skip-interpreter", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.size <= 100000 or not 3 <= args.repetitions <= 15:
        parser.error("size must be 1..100000 and repetitions 3..15")
    if platform.system() != "Windows":
        parser.error("reference.c uses Windows QPC; this benchmark profile is Windows-only")
    for tool in ("go", "gcc", "g++", "node"):
        if shutil.which(tool) is None:
            parser.error(f"required local tool unavailable: {tool}")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    mode = {"mandelbrot": 0, "primes": 1, "train": 2}[args.case]
    report: dict[str, Any] = {
        "status": "running", "started_utc": datetime.now(timezone.utc).isoformat(),
        "case": args.case, "mode": mode, "size": args.size, "seed": 20260928,
        "platform": platform.platform(), "cpu": os.environ.get("PROCESSOR_IDENTIFIER", "unknown"),
        "method": "serial fresh processes; one discarded warmup per implementation; seeded shuffled order each round; identical source algorithms and float64 workloads; Python oracle plus exact prime-count cross-check",
        "limitations": ["single non-isolated workstation", "fresh Node processes, not steady-state warmed JIT", "C/C++ same scalar C-style source, not a language-wide ranking", "Swyp retains finite-arithmetic/fuel checks unlike reference programs", "training timed region includes one WEIGHTS print in every implementation", "internal time excludes process start; wall time includes it", "build timings use existing compiler caches; not cold-build claims", "no GPU/framework/array/IO/concurrency benchmark"],
        "versions": {"Python": sys.version}, "builds": [], "commands": [],
        "warmups": [], "samples": [], "skipped": [],
    }
    def save() -> None:
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    def execute(command: list[Any], timeout: float = 60) -> tuple[str, float]:
        cmd = list(map(str, command))
        start = time.perf_counter()
        process = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, timeout=timeout)
        elapsed = time.perf_counter() - start
        report["commands"].append({"argv": cmd, "exit_code": process.returncode,
                                   "wall_seconds": elapsed, "stdout": process.stdout, "stderr": process.stderr})
        if process.returncode:
            raise RuntimeError(f"exit {process.returncode}: {cmd}: {process.stderr[-2000:]}")
        return process.stdout, elapsed
    def build(label: str, command: list[Any]) -> None:
        _, elapsed = execute(command)
        report["builds"].append({"implementation": label, "seconds": elapsed, "argv": list(map(str, command))})
    try:
        for tool in ("go", "gcc", "g++", "node"):
            text, _ = execute([tool, "version" if tool == "go" else "--version"])
            report["versions"][tool] = text.splitlines()[0]
        source_paths = [ROOT / "examples/swyp/compute.swyp", HERE / "reference.c", HERE / "reference.go",
                        HERE / "reference.py", HERE / "reference.rs", HERE / "reference.js", Path(__file__)]
        source_paths += sorted((ROOT / "internal/swyplang").glob("*.go"))
        report["source_sha256"] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths}
        swyp = out / "swyp-tool.exe"
        build("Swyp compiler", ["go", "build", "-o", swyp, "./cmd/swyp"])
        build("Swyp native", [swyp, "build", "-o", out / "swyp-native.exe", ROOT / "examples/swyp/compute.swyp"])
        commands: dict[str, list[Any]] = {"Swyp native": [out / "swyp-native.exe"]}
        for label, compiler, language in (("C", "gcc", "c"), ("C++", "g++", "c++")):
            target = out / f"{compiler}.exe"
            build(label, [compiler, "-x", language, "-O2", "-ffp-contract=off", HERE / "reference.c", "-o", target, "-lm"])
            commands[label] = [target]
        build("Go", ["go", "build", "-o", out / "go.exe", HERE / "reference.go"])
        commands.update({"Go": [out / "go.exe"], "Python": [sys.executable, HERE / "reference.py"],
                         "JavaScript / Node": ["node", HERE / "reference.js"]})
        if not args.skip_interpreter:
            commands["Swyp interpreter"] = [swyp, "run", "-steps", "1000000000", ROOT / "examples/swyp/compute.swyp"]
        if shutil.which("rustc"):
            report["versions"]["Rust"] = execute(["rustc", "--version"])[0].strip()
            build("Rust", ["rustc", "-C", "opt-level=2", HERE / "reference.rs", "-o", out / "rust.exe"])
            commands["Rust"] = [out / "rust.exe"]
        else:
            report["skipped"].append("Rust: rustc unavailable on PATH; no result inferred")
        report["binary_bytes"] = {p.name: p.stat().st_size for p in out.glob("*.exe")}
        text, _ = execute(commands["Python"] + [mode, args.size])
        oracle = parse_output(text)
        if mode == 1:
            sieve = bytearray(b"\x01") * (args.size + 1)
            sieve[:2] = b"\x00\x00"
            for p in range(2, math.isqrt(args.size) + 1):
                if sieve[p]:
                    for multiple in range(p*p, args.size+1, p): sieve[multiple] = 0
            if oracle["value"] != sum(sieve): raise ValueError("independent sieve disagrees")
        report["oracle"] = oracle
        def measure(label: str, repetition: int) -> dict[str, Any]:
            text, wall = execute(commands[label] + [mode, args.size])
            row = parse_output(text)
            validate(row, oracle, mode)
            return {"implementation": label, "repetition": repetition, "wall_seconds": wall, **row}
        for label in commands:
            report["warmups"].append(measure(label, -1))
        rng = random.Random(20260928)
        for repetition in range(args.repetitions):
            order = list(commands)
            rng.shuffle(order)
            for label in order:
                report["samples"].append(measure(label, repetition))
                save()
            print(f"Validated {args.case} round {repetition+1}/{args.repetitions}", flush=True)
        summary = []
        for label in commands:
            rows = [r for r in report["samples"] if r["implementation"] == label]
            times = [r["seconds"]*1000 for r in rows]
            summary.append({"implementation": label, "median_ms": statistics.median(times),
                            "min_ms": min(times), "max_ms": max(times),
                            "wall_median_ms": statistics.median(r["wall_seconds"]*1000 for r in rows),
                            "samples": len(rows)})
        report.update(status="passed", summary=summary, finished_utc=datetime.now(timezone.utc).isoformat())
        save()
        print(json.dumps(summary, indent=2))
        print(f"Evidence: {out / 'report.json'}")
    except BaseException as exc:
        report.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        save()
        raise


if __name__ == "__main__":
    main()
