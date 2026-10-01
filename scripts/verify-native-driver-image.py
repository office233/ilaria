#!/usr/bin/env python3
"""Differential conformance gate for the real Go and native C driver-image parsers."""

from __future__ import annotations

import dataclasses
import ctypes
import json
import os
from pathlib import Path
import shutil
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable

HEADER_BYTES = 64
SEGMENT_BYTES = 48
MAX_SEGMENTS = 8
MAX_PAGES = 256
MAX_SPAN = 0x10000000
PAGE_SIZE = 4096
READ = 1
WRITE = 2
EXECUTE = 4
MAX_CAPTURE = 64 << 10
PROBE_CAPTURE = 16 << 10
PROBE_TIMEOUT = 5.0
BUILD_TIMEOUT = 60.0
SEED = 0x5A17

ROOT = Path(__file__).resolve().parents[1]
SWYPIK = ROOT / "swypik-os"
GO_PROBE_SOURCE = ROOT / "scripts" / "native-driver-image" / "go_probe" / "main.go"
C_PROBE_SOURCE = ROOT / "scripts" / "native-driver-image" / "c_probe.c"
C_PARSER_SOURCE = SWYPIK / "kernel" / "src" / "arch" / "x86_64" / "driver_image.c"
C_INCLUDE = SWYPIK / "kernel" / "include"


@dataclasses.dataclass(frozen=True)
class Segment:
    virtual_offset: int
    file_size: int
    memory_size: int
    flags: int
    file_offset: int | None = None
    reserved: int = 0


@dataclasses.dataclass(frozen=True)
class Case:
    name: str
    image: bytes
    accepted: bool
    expected: dict[str, Any] | None = None


class GateError(RuntimeError):
    pass


def p16(buffer: bytearray, offset: int, value: int) -> None:
    struct.pack_into("<H", buffer, offset, value & 0xFFFF)


def p32(buffer: bytearray, offset: int, value: int) -> None:
    struct.pack_into("<I", buffer, offset, value & 0xFFFFFFFF)


def p64(buffer: bytearray, offset: int, value: int) -> None:
    struct.pack_into("<Q", buffer, offset, value & 0xFFFFFFFFFFFFFFFF)


def build_image(
    segments: Iterable[Segment],
    *,
    entry_rva: int = 0,
    image_span: int | None = None,
    version: int = 1,
    header_bytes: int = HEADER_BYTES,
    reserved16: int = 0,
    header_flags: int = 0,
    reserved32: int = 0,
    reserved40: int = 0,
    reserved48: int = 0,
    reserved56: int = 0,
) -> tuple[bytes, dict[str, Any]]:
    segs = list(segments)
    metadata_end = HEADER_BYTES + SEGMENT_BYTES * len(segs)
    if image_span is None:
        image_span = max((s.virtual_offset + s.memory_size for s in segs), default=PAGE_SIZE)

    resolved: list[dict[str, int]] = []
    cursor = metadata_end
    final_size = metadata_end
    for index, segment in enumerate(segs):
        file_offset = segment.file_offset
        if file_offset is None:
            file_offset = cursor if segment.file_size else 0
        if segment.file_size and file_offset < (2 << 20):
            final_size = max(final_size, file_offset + segment.file_size)
            if segment.file_offset is None:
                cursor = file_offset + segment.file_size
        resolved.append(
            {
                "virtual_offset": segment.virtual_offset,
                "file_offset": file_offset,
                "file_size": segment.file_size,
                "memory_size": segment.memory_size,
                "flags": segment.flags,
                "reserved": segment.reserved,
            }
        )

    # Intentionally malformed huge file offsets must not force huge allocations.
    final_size = min(final_size, 2 << 20)
    image = bytearray(final_size)
    image[:8] = b"SWYDRV1\x00"
    p16(image, 8, version)
    p16(image, 10, header_bytes)
    p16(image, 12, len(segs))
    p16(image, 14, reserved16)
    p32(image, 16, header_flags)
    p32(image, 20, reserved32)
    p64(image, 24, entry_rva)
    p64(image, 32, image_span)
    p64(image, 40, reserved40)
    p64(image, 48, reserved48)
    p64(image, 56, reserved56)

    for index, segment in enumerate(resolved):
        offset = HEADER_BYTES + index * SEGMENT_BYTES
        p64(image, offset + 0, segment["virtual_offset"])
        p64(image, offset + 8, segment["file_offset"])
        p64(image, offset + 16, segment["file_size"])
        p64(image, offset + 24, segment["memory_size"])
        p64(image, offset + 32, segment["flags"])
        p64(image, offset + 40, segment["reserved"])
        file_offset = segment["file_offset"]
        file_size = segment["file_size"]
        if file_size and file_offset + file_size <= len(image):
            for i in range(file_size):
                image[file_offset + i] = (SEED + index * 37 + i) & 0xFF

    total_pages = sum(segment["memory_size"] // PAGE_SIZE for segment in resolved)
    expected = {
        "accepted": True,
        "entry_rva": entry_rva,
        "image_span": image_span,
        "segment_count": len(resolved),
        "total_pages": total_pages,
        "segments": [
            {
                "virtual_offset": s["virtual_offset"],
                "file_offset": s["file_offset"],
                "file_size": s["file_size"],
                "memory_size": s["memory_size"],
                "flags": s["flags"],
            }
            for s in resolved
        ],
    }
    return bytes(image), expected


def mutated(image: bytes, *, u16: dict[int, int] | None = None, u32: dict[int, int] | None = None,
            u64: dict[int, int] | None = None, byte: dict[int, int] | None = None) -> bytes:
    data = bytearray(image)
    for offset, value in (byte or {}).items():
        data[offset] = value & 0xFF
    for offset, value in (u16 or {}).items():
        p16(data, offset, value)
    for offset, value in (u32 or {}).items():
        p32(data, offset, value)
    for offset, value in (u64 or {}).items():
        p64(data, offset, value)
    return bytes(data)


def corpus() -> list[Case]:
    cases: list[Case] = []

    single, single_expected = build_image(
        [Segment(0, 16, PAGE_SIZE, READ | EXECUTE)],
        entry_rva=0,
        image_span=PAGE_SIZE,
    )
    cases.append(Case("valid_single", single, True, single_expected))

    field_image, field_expected = build_image(
        [
            Segment(0, 17, PAGE_SIZE, READ | EXECUTE),
            Segment(2 * PAGE_SIZE, 33, 2 * PAGE_SIZE, READ | WRITE),
        ],
        entry_rva=16,
        image_span=4 * PAGE_SIZE,
    )
    cases.append(Case("valid_all_fields_gap", field_image, True, field_expected))

    touching, touching_expected = build_image(
        [
            Segment(0, 0, PAGE_SIZE, READ | EXECUTE),
            Segment(PAGE_SIZE, 0, PAGE_SIZE, READ | WRITE),
        ],
        entry_rva=PAGE_SIZE - 1,
        image_span=2 * PAGE_SIZE,
    )
    cases.append(Case("valid_touching_segments_entry_last_byte", touching, True, touching_expected))

    max_span, max_span_expected = build_image(
        [Segment(0, 0, PAGE_SIZE, READ | EXECUTE)],
        entry_rva=0,
        image_span=MAX_SPAN,
    )
    cases.append(Case("valid_max_image_span", max_span, True, max_span_expected))

    max_pages, max_pages_expected = build_image(
        [Segment(0, 0, MAX_PAGES * PAGE_SIZE, READ | EXECUTE)],
        entry_rva=0,
        image_span=MAX_PAGES * PAGE_SIZE,
    )
    cases.append(Case("valid_exact_page_cap", max_pages, True, max_pages_expected))

    eight_segments = [
        Segment(i * PAGE_SIZE, 0, PAGE_SIZE, READ | (EXECUTE if i == 0 else 0))
        for i in range(MAX_SEGMENTS)
    ]
    max_segments, max_segments_expected = build_image(
        eight_segments, entry_rva=0, image_span=MAX_SEGMENTS * PAGE_SIZE
    )
    cases.append(Case("valid_exact_segment_cap", max_segments, True, max_segments_expected))

    trunc_base, _ = build_image(
        [
            Segment(0, 17, PAGE_SIZE, READ | EXECUTE),
            Segment(PAGE_SIZE, 33, PAGE_SIZE, READ | WRITE),
            Segment(2 * PAGE_SIZE, 7, PAGE_SIZE, READ),
        ],
        entry_rva=8,
        image_span=3 * PAGE_SIZE,
    )
    metadata_end = HEADER_BYTES + 3 * SEGMENT_BYTES
    payload_ends = [metadata_end + 17, metadata_end + 17 + 33, len(trunc_base)]
    boundaries = [8, 10, 12, 14, 16, 20, 24, 32, 40, 48, 56, 64, 112, 160, metadata_end, *payload_ends]
    lengths: set[int] = set()
    for boundary in boundaries:
        for length in (boundary - 1, boundary):
            if 0 <= length < len(trunc_base):
                lengths.add(length)
    lengths.update({0, 1, 7, 63, len(trunc_base) - 1})
    for length in sorted(lengths):
        cases.append(Case(f"reject_truncated_{length}", trunc_base[:length], False))

    header_rejects = [
        ("magic", mutated(single, byte={0: ord("X")})),
        ("version_zero", mutated(single, u16={8: 0})),
        ("version_two", mutated(single, u16={8: 2})),
        ("header_bytes_63", mutated(single, u16={10: 63})),
        ("header_bytes_65", mutated(single, u16={10: 65})),
        ("segment_count_zero", mutated(single, u16={12: 0})),
        ("segment_count_over_cap", mutated(single, u16={12: MAX_SEGMENTS + 1})),
        ("reserved16", mutated(single, u16={14: 1})),
        ("header_flags", mutated(single, u32={16: 1})),
        ("reserved32", mutated(single, u32={20: 1})),
        ("reserved40", mutated(single, u64={40: 1})),
        ("reserved48", mutated(single, u64={48: 1})),
        ("reserved56", mutated(single, u64={56: 1})),
        ("span_zero", mutated(single, u64={32: 0})),
        ("span_unaligned", mutated(single, u64={32: PAGE_SIZE + 1})),
        ("span_over_max", mutated(single, u64={32: MAX_SPAN + PAGE_SIZE})),
        ("entry_at_span", mutated(single, u64={24: PAGE_SIZE})),
        ("entry_uint64_max", mutated(single, u64={24: 0xFFFFFFFFFFFFFFFF})),
    ]
    cases.extend(Case(f"reject_header_{name}", image, False) for name, image in header_rejects)

    seg = HEADER_BYTES
    segment_rejects = [
        ("reserved", mutated(single, u64={seg + 40: 1})),
        ("memory_zero", mutated(single, u64={seg + 24: 0})),
        ("virtual_unaligned", mutated(single, u64={seg + 0: 1})),
        ("memory_unaligned", mutated(single, u64={seg + 24: PAGE_SIZE - 1})),
        ("memory_over_span", mutated(single, u64={seg + 24: 2 * PAGE_SIZE})),
        ("virtual_outside_span", mutated(single, u64={seg + 0: PAGE_SIZE})),
        ("file_size_over_memory", mutated(single, u64={seg + 16: PAGE_SIZE + 1})),
        ("file_offset_uint64_overflow", mutated(single, u64={seg + 8: 0xFFFFFFFFFFFFFFF8, seg + 16: 16})),
        ("metadata_overlap", mutated(single, u64={seg + 8: HEADER_BYTES + SEGMENT_BYTES - 1, seg + 16: 1})),
        ("missing_read", mutated(single, u64={seg + 32: EXECUTE})),
        ("unknown_flag", mutated(single, u64={seg + 32: READ | (1 << 63)})),
        ("write_execute", mutated(single, u64={seg + 32: READ | WRITE | EXECUTE})),
        ("no_executable_entry", mutated(single, u64={seg + 32: READ | WRITE})),
    ]
    cases.extend(Case(f"reject_segment_{name}", image, False) for name, image in segment_rejects)

    overlap, _ = build_image(
        [
            Segment(0, 0, 2 * PAGE_SIZE, READ | EXECUTE),
            Segment(PAGE_SIZE, 0, PAGE_SIZE, READ),
        ],
        entry_rva=0,
        image_span=2 * PAGE_SIZE,
    )
    cases.append(Case("reject_virtual_overlap", overlap, False))

    entry_nonexec, _ = build_image(
        [
            Segment(0, 0, PAGE_SIZE, READ | EXECUTE),
            Segment(PAGE_SIZE, 0, PAGE_SIZE, READ | WRITE),
        ],
        entry_rva=PAGE_SIZE,
        image_span=2 * PAGE_SIZE,
    )
    cases.append(Case("reject_entry_in_nonexecutive_segment", entry_nonexec, False))

    over_pages, _ = build_image(
        [Segment(0, 0, (MAX_PAGES + 1) * PAGE_SIZE, READ | EXECUTE)],
        entry_rva=0,
        image_span=(MAX_PAGES + 1) * PAGE_SIZE,
    )
    cases.append(Case("reject_page_cap_plus_one", over_pages, False))

    return cases


def windows_job() -> tuple[Any, Any]:
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
            ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
            ("maximum_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("reads", "writes", "other", "read_bytes", "write_bytes", "other_bytes")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", IOCounters),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        error = ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(job)
        raise error
    return kernel, job


def start_owned_process(command: list[str], cwd: Path, env: dict[str, str] | None) -> tuple[Any, Any]:
    job = windows_job() if os.name == "nt" else None
    process = None
    try:
        if job:
            # A child cannot execute the command or spawn descendants before it
            # belongs to our job. Closing that job also kills any descendants.
            wrapper = (
                "import json,subprocess,sys; "
                "sys.stdin.buffer.read(1)==b'1' or sys.exit(125); "
                "sys.exit(subprocess.call(json.loads(sys.argv[1]),stdin=subprocess.DEVNULL))"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", wrapper, json.dumps(command)], cwd=str(cwd), env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            kernel, handle = job
            child = kernel.OpenProcess(0x0101, False, process.pid)  # SET_QUOTA | TERMINATE
            if not child:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if not kernel.AssignProcessToJobObject(handle, child):
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                kernel.CloseHandle(child)
            process.stdin.write(b"1")
            process.stdin.flush()
            process.stdin.close()
        else:
            process = subprocess.Popen(
                command, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            )
        return process, job
    except Exception:
        if job:
            job[0].CloseHandle(job[1])
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        raise


def stop_owned_tree(process: Any, job: Any) -> None:
    if job:
        if not job[0].CloseHandle(job[1]):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=5)


def run_bounded(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None,
    timeout: float,
    capture_limit: int,
) -> tuple[int, bytes, bytes]:
    if not command or timeout <= 0 or capture_limit <= 0:
        raise GateError("invalid bounded subprocess configuration")
    try:
        process, job = start_owned_process(command, cwd, env)
    except OSError as exc:
        raise GateError(f"failed to start {command[0]}: {exc}") from exc
    overflow = threading.Event()
    errors: list[Exception] = []
    buffers = [bytearray(), bytearray()]

    def capture(stream: Any, buffer: bytearray) -> None:
        try:
            while True:
                remaining = capture_limit - len(buffer)
                chunk = stream.read(min(4096, remaining + 1))
                if not chunk:
                    return
                buffer.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()
                    return
        except Exception as exc:
            errors.append(exc)
        finally:
            stream.close()

    readers = [threading.Thread(target=capture, args=(stream, buffer), daemon=True)
               for stream, buffer in zip((process.stdout, process.stderr), buffers)]
    deadline = time.monotonic() + timeout
    reason = None
    try:
        for reader in readers:
            reader.start()
        while process.poll() is None:
            if overflow.wait(0.01):
                reason = f"subprocess output exceeded {capture_limit} bytes: {command[0]}"
                break
            if time.monotonic() >= deadline:
                reason = f"timeout after {timeout:.1f}s: {command[0]}"
                break
    finally:
        # Also reap residual descendants after a successful parent exit.
        stop_owned_tree(process, job)
        for reader in readers:
            reader.join(timeout=5)
    if any(reader.is_alive() for reader in readers):
        raise GateError("capture did not close after process-tree cleanup")
    if reason:
        raise GateError(reason)
    if overflow.is_set():
        raise GateError(f"subprocess output exceeded {capture_limit} bytes: {command[0]}")
    if errors:
        raise GateError(f"subprocess capture failed: {errors[0]}")
    return process.returncode, bytes(buffers[0]), bytes(buffers[1])


def go_environment(temp_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["GOWORK"] = "off"
    env["GOTOOLCHAIN"] = "local"
    current_flags = env.get("GOFLAGS", "").strip()
    env["GOFLAGS"] = (current_flags + " -buildvcs=false").strip()
    env["GOCACHE"] = str(temp_root / "gocache")
    env["GOTMPDIR"] = str(temp_root / "gotmp")
    (temp_root / "gocache").mkdir()
    (temp_root / "gotmp").mkdir()
    return env


def build_go_probe(temp_root: Path) -> Path:
    go = shutil.which("go")
    if not go:
        raise GateError("Go compiler unavailable in PATH")
    module_dir = temp_root / "go-probe"
    module_dir.mkdir()
    shutil.copy2(GO_PROBE_SOURCE, module_dir / "main.go")
    swypik_path = SWYPIK.resolve().as_posix()
    (module_dir / "go.mod").write_text(
        f"module native-driver-image-probe\n\ngo 1.26.0\n\n"
        f"require swypik-os v0.0.0\nreplace swypik-os => {swypik_path}\n",
        encoding="utf-8",
    )
    output = temp_root / ("go-probe.exe" if os.name == "nt" else "go-probe")
    env = go_environment(temp_root)
    code, stdout, stderr = run_bounded(
        [go, "build", "-trimpath", "-o", str(output), "."],
        cwd=module_dir,
        env=env,
        timeout=BUILD_TIMEOUT,
        capture_limit=MAX_CAPTURE,
    )
    if code != 0:
        detail = (stderr or stdout).decode("utf-8", "replace").strip()
        raise GateError(f"Go probe build failed ({code}): {detail[:4000]}")
    return output


def detect_c_compiler() -> tuple[str, list[str]]:
    if os.environ.get("SWYPIK_ZIG"):
        zig = Path(os.environ["SWYPIK_ZIG"])
        if not zig.is_file():
            raise GateError(f"configured SWYPIK_ZIG unavailable: {zig}")
        return "gnu", [str(zig), "cc"]
    if os.environ.get("CC"):
        if os.name == "nt":
            from ctypes import wintypes
            shell = ctypes.WinDLL("shell32", use_last_error=True)
            shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
            shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
            count = ctypes.c_int()
            argv = shell.CommandLineToArgvW(os.environ["CC"].strip(), ctypes.byref(count))
            if not argv:
                raise GateError("cannot parse configured CC command line")
            try:
                parts = [argv[i] for i in range(count.value)]
            finally:
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.LocalFree.argtypes = [ctypes.c_void_p]
                kernel.LocalFree.restype = ctypes.c_void_p
                kernel.LocalFree(ctypes.cast(argv, ctypes.c_void_p))
        else:
            parts = shlex.split(os.environ["CC"], posix=True)
        if not parts or not shutil.which(parts[0]):
            raise GateError(f"configured CC unavailable: {os.environ['CC']}")
        kind = "msvc" if Path(parts[0]).name.lower() in {"cl", "cl.exe"} else "gnu"
        return kind, parts
    for name in ("clang", "gcc", "cc"):
        path = shutil.which(name)
        if path:
            return "gnu", [path]
    cl = shutil.which("cl")
    if cl:
        return "msvc", [cl]
    zig = shutil.which("zig")
    if zig:
        return "gnu", [zig, "cc"]
    raise GateError("C compiler unavailable (tried CC, clang, gcc, cc, cl, zig cc)")


def build_c_probe(temp_root: Path) -> tuple[Path, str]:
    kind, compiler = detect_c_compiler()
    output = temp_root / ("c-probe.exe" if os.name == "nt" else "c-probe")
    if kind == "msvc":
        command = [
            *compiler,
            "/nologo",
            "/std:c11",
            "/O2",
            "/W4",
            f"/I{C_INCLUDE}",
            str(C_PROBE_SOURCE),
            str(C_PARSER_SOURCE),
            f"/Fe:{output}",
        ]
    else:
        command = [
            *compiler,
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-I",
            str(C_INCLUDE),
            str(C_PROBE_SOURCE),
            str(C_PARSER_SOURCE),
            "-o",
            str(output),
        ]
    code, stdout, stderr = run_bounded(
        command,
        cwd=temp_root,
        env=os.environ.copy(),
        timeout=BUILD_TIMEOUT,
        capture_limit=MAX_CAPTURE,
    )
    if code != 0:
        detail = (stderr or stdout).decode("utf-8", "replace").strip()
        raise GateError(f"C probe build failed ({code}): {detail[:4000]}")
    return output, " ".join(compiler)


def run_probe(executable: Path, image_path: Path) -> dict[str, Any]:
    code, stdout, stderr = run_bounded(
        [str(executable), str(image_path)],
        cwd=image_path.parent,
        env=os.environ.copy(),
        timeout=PROBE_TIMEOUT,
        capture_limit=PROBE_CAPTURE,
    )
    if code != 0:
        detail = (stderr or stdout).decode("utf-8", "replace").strip()
        raise GateError(f"{executable.name} exited {code}: {detail[:2000]}")
    try:
        value = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{executable.name} emitted invalid JSON: {stdout[:200]!r}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("accepted"), bool):
        raise GateError(f"{executable.name} emitted invalid result shape")
    return value


def common_result(value: dict[str, Any]) -> dict[str, Any]:
    if not value["accepted"]:
        return {"accepted": False}
    keys = ("entry_rva", "image_span", "segment_count", "total_pages", "segments")
    result = {"accepted": True}
    for key in keys:
        if key not in value:
            raise GateError(f"accepted probe result missing {key}")
        result[key] = value[key]
    return result


def preserve_repro(case: Case, go_result: Any, c_result: Any, reason: str) -> Path:
    repro = Path(tempfile.mkdtemp(prefix="nexus-native-driver-image-repro-"))
    (repro / f"{case.name}.bin").write_bytes(case.image)
    (repro / "go.json").write_text(json.dumps(go_result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (repro / "c.json").write_text(json.dumps(c_result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (repro / "README.txt").write_text(
        f"case={case.name}\nreason={reason}\nseed=0x{SEED:x}\n",
        encoding="utf-8",
    )
    return repro


def verify_case(case: Case, go_result: dict[str, Any], c_result: dict[str, Any]) -> str | None:
    go_common = common_result(go_result)
    c_common = common_result(c_result)
    if go_common != c_common:
        return f"parser divergence go={go_common} c={c_common}"
    if go_common["accepted"] != case.accepted:
        return f"common-mode outcome mismatch expected accepted={case.accepted} actual={go_common['accepted']}"
    if case.accepted and case.expected is not None and go_common != case.expected:
        return f"valid field oracle mismatch expected={case.expected} actual={go_common}"
    return None


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="nexus-native-driver-image-"))
    try:
        try:
            go_probe = build_go_probe(temp_root)
            c_probe, compiler = build_c_probe(temp_root)
        except GateError as exc:
            print(f"UNAVAILABLE native-driver-image conformance: {exc}", file=sys.stderr)
            return 2

        cases = corpus()
        accepted_cases = sum(1 for case in cases if case.accepted)
        rejected_cases = len(cases) - accepted_cases
        image_path = temp_root / "case.bin"
        for index, case in enumerate(cases):
            image_path.write_bytes(case.image)
            try:
                go_result = run_probe(go_probe, image_path)
                c_result = run_probe(c_probe, image_path)
                reason = verify_case(case, go_result, c_result)
            except GateError as exc:
                go_result = {"probe_error": str(exc)}
                c_result = {}
                reason = str(exc)
            if reason is not None:
                repro = preserve_repro(case, go_result, c_result, reason)
                print(
                    f"FAIL case={case.name} index={index} bytes={len(case.image)} reason={reason} "
                    f"repro={repro}",
                    file=sys.stderr,
                )
                return 1

        print(
            f"PASS native-driver-image differential cases={len(cases)} valid={accepted_cases} "
            f"reject={rejected_cases} seed=0x{SEED:x} "
            f"go={go_probe.name} c={c_probe.name} compiler={compiler}"
        )
        return 0
    finally:
        # mkdtemp created this exact directory; never clean an arbitrary path.
        if temp_root.is_symlink() or temp_root.resolve().parent != Path(tempfile.gettempdir()).resolve():
            raise GateError("owned temporary directory containment changed")
        shutil.rmtree(temp_root)


if __name__ == "__main__":
    raise SystemExit(main())
