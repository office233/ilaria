#!/usr/bin/env python3
"""Compile real native cleanup C and run deterministic host faults; never install tools."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ["src/core/device_broker.c", "src/core/device_platform.c",
           "src/core/driver_domain.c", "src/core/capability.c", "src/core/device_graph.c",
           "tests/native_cleanup_fault_test.c"]
OUTPUT_LIMIT = 24000


def invoke(command, cwd, timeout, env=None):
    """Drain continuously, retain only a bounded prefix, and kill on deadline."""
    print("COMMAND:", subprocess.list2cmdline([str(x) for x in command]), flush=True)
    captured = bytearray()
    total = 0
    try:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    except OSError as error:
        print(f"UNAVAILABLE: {error}")
        return 2

    def drain():
        nonlocal total
        while True:
            chunk = process.stdout.read(4096)
            if not chunk:
                break
            total += len(chunk)
            captured.extend(chunk[:max(0, OUTPUT_LIMIT - len(captured))])

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        process.wait(timeout=10)
    reader.join(timeout=10)
    print(captured.decode("utf-8", errors="replace"), end="")
    if total > OUTPUT_LIMIT:
        print(f"\n[output truncated: {total} bytes; limit={OUTPUT_LIMIT}]")
    if timed_out:
        print(f"TIMEOUT: {timeout}s; exit=124")
        return 124
    if reader.is_alive():
        print("FAIL: output pipe did not close; exit=125")
        return 125
    print(f"EXIT: {process.returncode}")
    return process.returncode


def compiler_path(requested):
    if requested:
        return shutil.which(requested) or (str(Path(requested).resolve()) if Path(requested).is_file() else None)
    for name in ("cc", "gcc", "clang", "zig", "cl"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in sorted((ROOT / ".tools").glob("zig-*/zig.exe"), reverse=True):
        if candidate.is_file():
            return str(candidate)
    return None


def wsl_path(path):
    path = str(Path(path).resolve()).replace("\\", "/")
    if len(path) < 3 or path[1:3] != ":/":
        raise ValueError("WSL fallback needs a drive-qualified path")
    return "/mnt/" + path[0].lower() + path[2:]


def positive(value):
    result = float(value)
    if not 0 < result <= 600:
        raise argparse.ArgumentTypeError("timeout must be >0 and <=600 seconds")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", help="existing gcc/clang/zig/cl executable; no shell fragments")
    parser.add_argument("--case", help="exact C fixture name for reproduction")
    parser.add_argument("--compile-timeout", type=positive, default=90)
    parser.add_argument("--run-timeout", type=positive, default=20)
    parser.add_argument("--temp-root", type=Path, help="existing separate directory for owned temporary outputs")
    parser.add_argument("--native-only", action="store_true", help="disable Windows-to-WSL fallback")
    args = parser.parse_args()
    compiler = compiler_path(args.compiler)
    # The caller can select an approved output root. Otherwise tempfile uses
    # the host's TEMP/TMP configuration, never a developer-specific home path.
    temp_root = args.temp_root
    if temp_root is not None and not temp_root.is_dir():
        parser.error("--temp-root must already exist")
    if compiler is None:
        if not args.compiler and os.name == "nt" and not args.native_only and shutil.which("wsl"):
            command = ["wsl", "--exec", "python3", wsl_path(__file__), "--native-only",
                       "--compile-timeout", str(args.compile_timeout), "--run-timeout", str(args.run_timeout)]
            if temp_root:
                command += ["--temp-root", wsl_path(temp_root)]
            if args.case:
                command += ["--case", args.case]
            return invoke(command, ROOT, args.compile_timeout + args.run_timeout + 30)
        print("UNAVAILABLE: no existing host C compiler; matrix NOT RUN; exit=2")
        return 2
    with tempfile.TemporaryDirectory(prefix="oc3-native-cleanup-", dir=temp_root) as directory:
        out = Path(directory)
        executable = out / ("native_cleanup_fault_test.exe" if os.name == "nt" else "native_cleanup_fault_test")
        kernel = ROOT / "swypik-os/kernel"
        sources = [str(kernel / source) for source in SOURCES]
        name = Path(compiler).stem.lower()
        if name == "cl":
            command = [compiler, "/nologo", "/std:c11", "/W4", "/WX", "/I" + str(kernel / "include")]
            command += sources + ["/Fe:" + str(executable)]
        else:
            command = [compiler] + (["cc"] if name == "zig" else [])
            command += ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", str(kernel / "include")]
            command += sources + ["-o", str(executable)]
        env = os.environ.copy()
        env.update({"TMPDIR": directory, "TMP": directory, "TEMP": directory,
                    "ZIG_LOCAL_CACHE_DIR": str(out / "zig-local"), "ZIG_GLOBAL_CACHE_DIR": str(out / "zig-global")})
        result = invoke(command, out, args.compile_timeout, env)
        if result:
            print("FAIL: compile did not succeed; matrix NOT RUN")
            return result if result > 0 else 1
        result = invoke([str(executable)] + ([args.case] if args.case else []), out, args.run_timeout, env)
        print("PASS: native cleanup matrix" if result == 0 else
              "FAIL: native cleanup matrix; repro: python scripts/verify-native-cleanup.py --case <case from FAIL>")
        return result if result >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
