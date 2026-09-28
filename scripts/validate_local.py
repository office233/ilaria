#!/usr/bin/env python3
"""Reproducible local validation. Uses only Python's standard library.

All generated data stays in an ignored agent-lab directory. No git reset, clean,
push, installation or modification of user source is done.
The Go toolchain/GCC are developer prerequisites, not Swyp runtime dependencies.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
PHASES = (
    "tests", "vet", "race", "shuffle", "contracts", "fuzz-stv1", "fuzz-stv2",
    "fuzz-assembly", "fuzz-compiler", "fuzz-module", "smoke", "bench",
)
FUZZ = {
    "fuzz-stv1": ("./experiments/ternaryvm", "FuzzDecode"),
    "fuzz-stv2": ("./experiments/ternaryvm", "FuzzSTV2DecodeAudit"),
    "fuzz-assembly": ("./experiments/ternaryvm", "FuzzSTV2AssemblyAudit"),
    "fuzz-compiler": ("./internal/swyplang", "FuzzSTV2CompilerAudit"),
    "fuzz-module": ("./internal/swyplang", "FuzzSWYPBLoad"),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Validation:
    def __init__(self, output: Path, phase: str, fuzz_seconds: int):
        self.phase = phase
        self.fuzz_seconds = fuzz_seconds
        self.directory = output / (phase + "-" + dt.datetime.now().strftime("%H%M%S") + "-" + uuid.uuid4().hex[:6])
        self.directory.mkdir(parents=True, exist_ok=False)
        self.env = dict(os.environ, GOTOOLCHAIN="local", GOMAXPROCS="2")
        self.steps: list[dict] = []
        self.checks: list[str] = []
        self.go = shutil.which("go")
        if not self.go:
            raise RuntimeError("go is required to validate compiler sources")
        self.started = dt.datetime.now(dt.timezone.utc).isoformat()

    def command(self, name: str, argv: list[str], *, env: dict | None = None,
                timeout: int = 240, expect: int = 0, contains: str | None = None) -> subprocess.CompletedProcess:
        print("RUN", name, flush=True)
        started = time.monotonic()
        proc = subprocess.Popen(argv, cwd=ROOT, env=env or self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # Stop only the process tree launched by this validation step.
            if os.name == "nt":
                subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"),
                                "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=15)
            else:
                proc.kill()
            stdout, stderr = proc.communicate(timeout=20)
        out_path, err_path = self.directory / (name + ".stdout.txt"), self.directory / (name + ".stderr.txt")
        out_path.write_bytes(stdout)
        err_path.write_bytes(stderr)
        text = (stdout + stderr).decode("utf-8", errors="replace")
        ok = not timed_out and proc.returncode == expect and (contains is None or contains.lower() in text.lower())
        step = {
            "name": name, "argv": argv, "exit_code": proc.returncode,
            "expected_exit_code": expect, "duration_seconds": round(time.monotonic() - started, 3),
            "timed_out": timed_out, "passed": ok,
            "stdout": out_path.name, "stderr": err_path.name,
        }
        fuzz_counts = re.findall(r"execs:\s*(\d+)", text)
        if fuzz_counts:
            step["fuzz_executions"] = int(fuzz_counts[-1])
        if "-json" in argv:
            events = []
            for line in stdout.decode("utf-8", errors="replace").splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            step["top_level_tests_passed"] = sum(e.get("Action") == "pass" and bool(e.get("Test")) and "/" not in e["Test"] for e in events)
            step["top_level_tests_skipped"] = [e["Package"] + ":" + e["Test"] for e in events if e.get("Action") == "skip" and e.get("Test") and "/" not in e["Test"]]
            step["packages_passed"] = [e["Package"] for e in events if e.get("Action") == "pass" and not e.get("Test")]
            step["failed_tests"] = [e.get("Package", "") + ":" + e.get("Test", "") for e in events if e.get("Action") == "fail"]
        self.steps.append(step)
        print(("PASS" if ok else "FAIL") + " " + name + " " + str(step["duration_seconds"]) + "s", flush=True)
        if fuzz_counts:
            print("  fuzz executions:", fuzz_counts[-1], flush=True)
        if "top_level_tests_passed" in step:
            print("  top-level passes:", step["top_level_tests_passed"], "skips:", step["top_level_tests_skipped"], flush=True)
        elif text:
            print("\n".join(text.splitlines()[-12:]), flush=True)
        if not ok:
            raise RuntimeError(name + " failed; see " + str(self.directory))
        return subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)

    def check(self, condition: bool, description: str) -> None:
        if not condition:
            raise RuntimeError("assertion failed: " + description)
        self.checks.append(description)

    def smoke(self) -> None:
        exe = self.directory / ("swyp.exe" if os.name == "nt" else "swyp")
        self.command("build-swyp", [self.go, "build", "-o", str(exe), "./cmd/swyp"],
                     env=dict(self.env, CGO_ENABLED="0"))
        empty_path = self.directory / "no-toolchains"
        empty_path.mkdir()
        guest_env = dict(self.env, PATH=str(empty_path))
        source = self.directory / "program cu spatii.swyp"
        source.write_text((ROOT / "examples/swyp/sum.stv2.swyp").read_text(encoding="utf-8"), encoding="utf-8")
        module = self.directory / "suma.swypb"
        self.command("compile-no-toolchains", [str(exe), "compile", "--target", "stv2", "-o", str(module), str(source)], env=guest_env)
        self.check(module.stat().st_size == 157, "sum module occupies 157 bytes")
        original_hash = sha256(module)
        self.command("refuse-overwrite", [str(exe), "compile", "-o", str(module), str(source)], env=guest_env, expect=1, contains="exists")
        self.check(sha256(module) == original_hash, "refusing overwrite preserves module bytes")
        source.unlink()  # This is our generated test copy, NOT the repository example.
        self.check(not source.exists(), "generated test source removed before execution")
        for n in [-10, 0, 1, 10, 100, 1000]:
            proc = self.command("exec-sum-" + str(n), [str(exe), "exec", str(module), str(n)], env=guest_env)
            value = json.loads(proc.stdout)
            k = max(n, 0)
            self.check(value["value"] == k * (k + 1) // 2 and value["format"] == "SWYPB", "source-free sum for n=" + str(n))
        self.command("fuel-exhaustion", [str(exe), "exec", "-steps", "1", str(module), "100"], env=guest_env, expect=1, contains="fuel")
        self.command("wrong-arity", [str(exe), "exec", str(module)], env=guest_env, expect=1, contains="expected")
        damaged = bytearray(module.read_bytes())
        damaged[-1] ^= 1
        bad = self.directory / "corrupt.swypb"
        bad.write_bytes(damaged)
        self.command("reject-corruption", [str(exe), "exec", str(bad), "100"], env=guest_env, expect=1, contains="checksum")
        bool_source = self.directory / "equal.swyp"
        bool_source.write_text("fn main() -> bool { return arg(0) == arg(1); }\n", encoding="utf-8")
        bool_module = self.directory / "equal.swypb"
        self.command("compile-boolean", [str(exe), "compile", "-o", str(bool_module), str(bool_source)], env=guest_env)
        bool_source.unlink()
        for a, b, expected in [(5, 5, True), (5, 6, False), (-8, -8, True)]:
            proc = self.command("exec-bool-" + str(a) + "-" + str(b), [str(exe), "exec", str(bool_module), str(a), str(b)], env=guest_env)
            value = json.loads(proc.stdout)
            self.check(value["value"] is expected and value["result_type"] == "bool", "boolean result preserves type for " + str((a, b)))
        self.command("assembly-stv2", [str(exe), "ternary", str(ROOT / "examples/swyp/sum.ternary-v2.tasm"), "100"], env=guest_env, contains="value=5050")
        hello = self.directory / "hello.swyp"
        hello.write_text('fn main() { print("Swyp local", 7 * 6); }\n', encoding="utf-8")
        proc = self.command("original-interpreter", [str(exe), "run", str(hello)], env=guest_env)
        self.check(proc.stdout.decode().strip() == "Swyp local 42", "original Swyp interpreter still runs")
        native = self.directory / ("hello.exe" if os.name == "nt" else "hello")
        self.command("original-native-build", [str(exe), "build", "-o", str(native), str(hello)])
        proc = self.command("original-native-exec", [str(native)])
        self.check(proc.stdout.decode().strip() == "Swyp local 42", "original C/native backend still runs")
        html = self.directory / "hello.html"
        self.command("original-web-generation", [str(exe), "web", "-o", str(html), str(hello)], env=guest_env)
        self.check("<html" in html.read_text(encoding="utf-8").lower(), "HTML generation succeeds (not visual browser validation)")
        (self.directory / "binary-sha256.txt").write_text(sha256(exe) + "  " + exe.name + "\n", encoding="utf-8")

    def run(self) -> None:
        if self.phase == "tests":
            self.command("full-tests", [self.go, "test", "-json", "-count=1", "-timeout=180s", "-coverprofile=" + str(self.directory / "coverage.out"), "./..."])
        elif self.phase == "vet":
            self.command("vet", [self.go, "vet", "./..."])
        elif self.phase == "race":
            self.command("race", [self.go, "test", "-race", "-json", "-count=1", "-timeout=180s", "./..."], env=dict(self.env, CGO_ENABLED="1"))
        elif self.phase == "shuffle":
            self.command("shuffled-regression", [self.go, "test", "-json", "-shuffle=on", "-count=3", "-timeout=180s", "./..."], timeout=300)
        elif self.phase == "contracts":
            self.command("contracts", [self.go, "test", "-v", "-count=1", "-timeout=180s", "-run", "^Test(STV2|V2|SWYPB)", "./experiments/ternaryvm", "./internal/swyplang", "./cmd/swyp"])
        elif self.phase in FUZZ:
            package, name = FUZZ[self.phase]
            self.command(self.phase, [self.go, "test", package, "-run", "^$", "-fuzz", "^" + name + "$", "-fuzztime=" + str(self.fuzz_seconds) + "s", "-parallel=2", "-timeout=120s"], timeout=150)
        elif self.phase == "smoke":
            self.smoke()
        elif self.phase == "bench":
            self.command("benchmark", [self.go, "test", "./internal/swyplang", "-run", "^$", "-bench", "^BenchmarkSTV2LoweredSum$", "-benchmem", "-benchtime=200ms", "-count=3"])

    def save(self, error: str | None) -> None:
        git = shutil.which("git")
        head = subprocess.run([git, "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, check=True).stdout.decode().strip() if git else None
        result = {
            "phase": self.phase, "started_utc": self.started,
            "finished_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "head_commit": head, "runner_sha256": sha256(Path(__file__)),
            "passed": error is None, "error": error,
            "steps": self.steps, "assertions_passed": self.checks,
        }
        (self.directory / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print("EVIDENCE", self.directory, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=(*PHASES, "all"), default="all")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fuzz-seconds", type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.fuzz_seconds <= 60:
        parser.error("fuzz-seconds must be 1..60")
    output = (args.output or ROOT / "agent-lab" / ("validation-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))).resolve()
    try:
        output.relative_to((ROOT / "agent-lab").resolve())
    except ValueError:
        parser.error("output must be inside the project's agent-lab directory")
    for phase in PHASES if args.phase == "all" else (args.phase,):
        run = Validation(output, phase, args.fuzz_seconds)
        error = None
        try:
            run.run()
        except Exception as exc:
            error = str(exc)
            print("FAIL", error, file=sys.stderr, flush=True)
        finally:
            run.save(error)
        if error:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
