#!/usr/bin/env python3
"""Compile the real seed device-graph decoder and compare it to Go wire output."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
from typing import Sequence


ROOT = Path(__file__).resolve().parents[2]
OS_ROOT = ROOT / "swypik-os"
INCLUDE = OS_ROOT / "kernel" / "include"
PROBE = OS_ROOT / "kernel" / "tests" / "nativegraph_wire_probe.c"
DECODER = OS_ROOT / "kernel" / "src" / "core" / "device_graph.c"
CAPABILITY = OS_ROOT / "kernel" / "src" / "core" / "capability.c"


class VerifyError(RuntimeError):
    pass


def run(args: Sequence[str], *, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=str(cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def require_ok(proc: subprocess.CompletedProcess[str], step: str) -> None:
    if proc.returncode == 0:
        return
    detail = (proc.stderr or proc.stdout).strip()
    raise VerifyError(f"{step} failed with exit {proc.returncode}: {detail}")


def workspace_zig() -> Path | None:
    tools = ROOT / "ramasite/local/tools"
    if not tools.is_dir():
        return None
    pattern = "zig-*/zig.exe" if os.name == "nt" else "zig-*/zig"
    candidates = sorted(tools.glob(pattern), reverse=True)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def native_compiler() -> tuple[list[str], str] | None:
    explicit = os.environ.get("NATIVEGRAPH_CC", "").strip()
    if explicit:
        path = Path(explicit)
        if path.is_file():
            if path.stem.lower() == "zig":
                return [str(path), "cc"], str(path)
            return [str(path)], str(path)
        found = shutil.which(explicit)
        if found:
            if Path(found).stem.lower() == "zig":
                return [found, "cc"], found
            return [found], found

    zig = workspace_zig()
    if zig is not None:
        return [str(zig), "cc"], str(zig)

    for name in ("clang", "gcc", "cc", "zig"):
        found = shutil.which(name)
        if found:
            if Path(found).stem.lower() == "zig":
                return [found, "cc"], found
            return [found], found
    return None


def wsl_path(path: Path) -> str:
    proc = run(["wsl.exe", "-e", "wslpath", "-a", str(path)], cwd=ROOT)
    require_ok(proc, f"wslpath {path}")
    return proc.stdout.strip()


def run_wsl_probe(wire: Path) -> tuple[dict[str, object], str] | None:
    if os.name != "nt" or shutil.which("wsl.exe") is None:
        return None
    discovery = run(
        ["wsl.exe", "-e", "sh", "-lc", "command -v cc || command -v gcc || command -v clang || command -v zig || true"],
        cwd=ROOT,
    )
    require_ok(discovery, "WSL compiler discovery")
    compiler = discovery.stdout.strip().splitlines()
    if not compiler:
        return None
    compiler_path = compiler[0].strip()
    compiler_cmd = [compiler_path]
    if Path(compiler_path).name == "zig":
        compiler_cmd.append("cc")

    temp_proc = run(
        ["wsl.exe", "-e", "sh", "-lc", "mktemp -d /tmp/nexus-nativegraph-worker4-r2.XXXXXX"],
        cwd=ROOT,
    )
    require_ok(temp_proc, "create WSL temporary directory")
    temp_dir = temp_proc.stdout.strip()
    if not temp_dir:
        raise VerifyError("WSL returned an empty temporary directory")
    try:
        output = temp_dir + "/nativegraph_wire_probe"
        compile_parts = compiler_cmd + [
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-I",
            wsl_path(INCLUDE),
            wsl_path(PROBE),
            wsl_path(DECODER),
            wsl_path(CAPABILITY),
            "-o",
            output,
        ]
        compile_cmd = " ".join(shlex.quote(part) for part in compile_parts)
        compiled = run(["wsl.exe", "-e", "sh", "-lc", compile_cmd], cwd=ROOT)
        require_ok(compiled, "compile C decoder probe in WSL")

        execute_cmd = " ".join(shlex.quote(part) for part in [output, wsl_path(wire)])
        executed = run(["wsl.exe", "-e", "sh", "-lc", execute_cmd], cwd=ROOT)
        require_ok(executed, "run C decoder probe in WSL")
        try:
            return json.loads(executed.stdout), f"wsl:{compiler_path}"
        except json.JSONDecodeError as exc:
            raise VerifyError(f"C decoder probe returned invalid JSON: {exc}: {executed.stdout!r}") from exc
    finally:
        cleanup = "rm -rf -- " + shlex.quote(temp_dir)
        run(["wsl.exe", "-e", "sh", "-lc", cleanup], cwd=ROOT)


def run_native_probe(wire: Path, temp: Path) -> tuple[dict[str, object], str] | None:
    compiler = native_compiler()
    if compiler is None:
        return None
    prefix, label = compiler
    output = temp / ("nativegraph_wire_probe.exe" if os.name == "nt" else "nativegraph_wire_probe")
    compiled = run(
        prefix
        + [
            "-std=c11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-I",
            str(INCLUDE),
            str(PROBE),
            str(DECODER),
            str(CAPABILITY),
            "-o",
            str(output),
        ],
        cwd=OS_ROOT,
    )
    require_ok(compiled, "compile C decoder probe")
    executed = run([str(output), str(wire)], cwd=OS_ROOT)
    require_ok(executed, "run C decoder probe")
    try:
        return json.loads(executed.stdout), label
    except json.JSONDecodeError as exc:
        raise VerifyError(f"C decoder probe returned invalid JSON: {exc}: {executed.stdout!r}") from exc


def main() -> int:
    summary: dict[str, object] = {
        "status": "FAIL",
        "go_fixture": "NOT_RUN",
        "c_decoder": "NOT_RUN",
        "comparison": "NOT_RUN",
    }
    try:
        focused = run(["go", "test", "-count=1", "./internal/nativegraph"], cwd=OS_ROOT)
        require_ok(focused, "Go nativegraph tests")

        with tempfile.TemporaryDirectory(prefix="nexus-nativegraph-worker4-r2-") as raw_temp:
            temp = Path(raw_temp)
            wire = temp / "fixture.bin"
            expected_path = temp / "expected.json"
            fixture_env = os.environ.copy()
            fixture_env["NATIVEGRAPH_FIXTURE_WIRE"] = str(wire)
            fixture_env["NATIVEGRAPH_FIXTURE_EXPECTED"] = str(expected_path)
            fixture = run(
                ["go", "test", "-count=1", "-run", "^TestWriteCProbeFixture$", "./internal/nativegraph"],
                cwd=OS_ROOT,
                env=fixture_env,
            )
            require_ok(fixture, "generate Go wire fixture")
            summary["go_fixture"] = "PASS"

            expected = json.loads(expected_path.read_text(encoding="utf-8"))
            native = run_native_probe(wire, temp)
            if native is None:
                native = run_wsl_probe(wire)
            if native is None:
                summary.update(
                    {
                        "status": "UNAVAILABLE",
                        "reason": "no existing C compiler found in workspace/PATH/WSL",
                        "c_decoder": "UNAVAILABLE",
                    }
                )
                print(json.dumps(summary, sort_keys=True))
                return 2

            decoded, compiler = native
            summary["compiler"] = compiler
            summary["c_decoder"] = "PASS"
            if decoded != expected:
                summary["comparison"] = "FAIL"
                summary["expected"] = expected
                summary["decoded"] = decoded
                print(json.dumps(summary, sort_keys=True))
                return 1

            summary["comparison"] = "PASS"
            summary["status"] = "PASS"
            summary["wire_bytes"] = wire.stat().st_size
            summary["node_count"] = expected["NodeCount"]
            summary["resource_count"] = expected["ResourceCount"]
            summary["edge_count"] = expected["EdgeCount"]
            print(json.dumps(summary, sort_keys=True))
            return 0
    except (OSError, VerifyError, json.JSONDecodeError) as exc:
        summary["reason"] = str(exc)
        print(json.dumps(summary, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
