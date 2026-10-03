#!/usr/bin/env python3
"""Exercise the real Swyp, SwypikOS supervisor and Ilaria verifier CLIs."""

from __future__ import annotations

import argparse
import base64
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone


# Public RFC 8032 test vector, also used by verify-effects.py. Not a production key.
TEST_SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
TEST_PUBLIC = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
CONTENT = b"Nexus supervisor v1\n"
MAX_LINE = 2 << 20
SOURCE = '''fn main() -> u64 {
    let first: bytes = read_file("input.txt");
    let second: bytes = read_file("input.txt");
    let now: u64 = clock();
    return bytes_len(first) + bytes_len(second);
}
'''


def encoded(value: object) -> bytes:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for before, after in (("&", r"\u0026"), ("<", r"\u003c"), (">", r"\u003e"),
                          ("\u2028", r"\u2028"), ("\u2029", r"\u2029")):
        raw = raw.replace(before, after)
    return raw.encode("utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_bytes(encoded(value) + b"\n")


def events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    # Inspect our fixture's public CK journal format. Replay/authority stays in CK.
    assert path.stat().st_size <= 32 << 20, "unexpected fixture journal size"
    raw = path.read_bytes()
    assert raw[:8] == b"SWCKJNL1", "invalid journal header"
    offset = 8
    collected = []
    while offset < len(raw):
        magic, length, complement = struct.unpack_from("<4sII", raw, offset)
        assert magic == b"CKF1" and length ^ complement == 0xFFFFFFFF
        assert 0 < length <= 16 << 20 and offset + 12 + length + 32 <= len(raw)
        body = raw[offset + 12:offset + 12 + length]
        assert hashlib.sha256(body).digest() == raw[offset + 12 + length:offset + 12 + length + 32]
        batch = json.loads(body)
        assert batch["version"] == 1 and batch["events"], batch
        collected.extend(batch["events"])
        offset += 12 + length + 32
    return collected


def committed_events(path: Path) -> list[dict]:
    return [event for event in events(path) if event["type"] == "intent.state_changed"
            and event["data"]["to"] == "COMMITTED"]


class Fixture:
    def __init__(self, args: argparse.Namespace, directory: Path, name: str):
        self.directory = directory / name
        self.directory.mkdir()
        root = self.directory / "read-root"
        root.mkdir()
        (root / "input.txt").write_bytes(CONTENT)
        source = self.directory / "plan.swyp"
        source.write_text(SOURCE, encoding="utf-8")
        keys = self.directory / "trust.json"
        write_json(keys, {"format": "ilaria-effect-trust-registry-v1", "keys": {
            "integration-test-key": {"executor_id": "integration-executor",
                                     "public_key": base64.b64encode(TEST_PUBLIC).decode(),
                                     "revoked": False}}})
        self.config = {
            "version": 2, "journal": str(self.directory / "control.jsonl"),
            "ledger_directory": str(self.directory / "ledgers"),
            "swyp_executable": args.swyp, "verifier_executable": args.verifier,
            "trust_registry": str(keys), "executor_id": "integration-executor",
            "executor_credential": "public-integration-executor-credential",
            "verifier_id": "integration-verifier",
            "verifier_credential": "public-integration-verifier-credential",
            "signer_key_id": "integration-test-key",
            "private_key": base64.b64encode(TEST_SEED + TEST_PUBLIC).decode(),
            "roots": {"fixture": str(root)}, "profile": "balanced",
            "device_class": "workstation", "cpu_time_ms": 5000,
            "rss_limit_bytes": 128 << 20, "sample_interval_ms": 20,
            "kernel_cpu_percent": 8, "kernel_memory_limit_bytes": 192 << 20,
            "kernel_max_processes": 16,
            "plans": [self.plan(name, source)],
        }
        if args.cgroup_root:
            self.config["linux_cgroup_root"] = args.cgroup_root
        self.path = self.directory / "host.json"
        self.supervisor = args.supervisor

    @staticmethod
    def plan(name: str, source: Path) -> dict:
        return {
            "id": name, "task_id": "task-" + name, "run_id": "run-" + name,
            "source": str(source), "entry": "main", "arguments": [],
            "deadline": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
            "max_effects": 3, "max_read_bytes": 2 * len(CONTENT), "fuel": 1000,
            "max_returned_bytes": 2 * len(CONTENT), "wall_time_ms": 10000,
            "scopes": [
                {"function": "main", "effect": "fs.read", "capability": "workspace_read",
                 "path": "input.txt", "root_id": "fixture", "max_read_bytes": len(CONTENT)},
                {"function": "main", "effect": "clock.read", "capability": "clock_read",
                 "path": "", "root_id": "", "max_read_bytes": 0}],
        }

    def save(self) -> None:
        write_json(self.path, self.config)

    def run(self, success: bool, recover: bool = False) -> dict:
        self.save()
        command = [self.supervisor, "--config", str(self.path), "--plan-id",
                   self.config["plans"][0]["id"]]
        if recover:
            command.append("--recover")
        process = subprocess.run(command, capture_output=True,
                                  text=True, encoding="utf-8", timeout=40)
        assert process.returncode == (0 if success else 1), (process.returncode, process.stderr,
                                                           process.stdout[:4096])
        lines = process.stdout.splitlines()
        assert len(lines) == 1 and len(lines[0].encode()) <= MAX_LINE, process.stdout[:4096]
        report = json.loads(lines[0])
        assert report["protocol_version"] == 1
        assert report["plan_id"] == self.config["plans"][0]["id"]
        assert (report["error_code"] == "") == success, report
        assert report["metrics"]["energy_measured"] is False, report
        return report

    @property
    def journal(self) -> Path:
        return Path(self.config["journal"])


class Service:
    def __init__(self, fixture: Fixture):
        fixture.save()
        self.process = subprocess.Popen([fixture.supervisor, "--config", str(fixture.path),
                                         "--serve"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.frames: queue.Queue = queue.Queue()
        self.errors = bytearray()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.stderr_reader = threading.Thread(target=self._stderr, daemon=True)
        self.reader.start()
        self.stderr_reader.start()

    def _read(self) -> None:
        try:
            while True:
                raw = self.process.stdout.readline(MAX_LINE + 1)
                if not raw:
                    self.frames.put(EOFError("supervisor output ended"))
                    return
                if len(raw) > MAX_LINE or not raw.endswith(b"\n"):
                    raise ValueError("oversized or unterminated supervisor frame")
                self.frames.put(json.loads(raw))
        except Exception as error:
            self.frames.put(error)

    def _stderr(self) -> None:
        while raw := self.process.stderr.read(4096):
            if len(self.errors) < 65536:
                self.errors.extend(raw[:65536 - len(self.errors)])

    def frame(self) -> dict:
        try:
            frame = self.frames.get(timeout=40)
        except queue.Empty as error:
            raise AssertionError("supervisor response deadline exceeded") from error
        if isinstance(frame, Exception):
            raise AssertionError(str(frame) + ": " + self.errors.decode("utf-8", errors="replace"))
        assert isinstance(frame, dict), frame
        return frame

    def send(self, value: dict) -> None:
        self.process.stdin.write(encoded(value) + b"\n")
        self.process.stdin.flush()

    def shutdown(self) -> None:
        self.send({"op": "shutdown"})
        self.process.stdin.close()
        assert self.process.wait(timeout=10) == 0, self.errors.decode("utf-8", errors="replace")
        self.reader.join(timeout=2)
        self.stderr_reader.join(timeout=2)
        assert self.frames.empty() or isinstance(self.frames.get_nowait(), EOFError), "extra service frame"

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream and not stream.closed:
                stream.close()
        self.reader.join(timeout=2)
        self.stderr_reader.join(timeout=2)


def child_pids(parent: int, executable: str) -> list[int]:
    """Find only this service's direct child with the expected executable name."""
    name = Path(executable).name
    if sys.platform == "linux":
        # Go may spawn the child from any OS thread, not the thread-group leader.
        children = set()
        for task in Path(f"/proc/{parent}/task").iterdir():
            try:
                children.update((task / "children").read_text().split())
            except FileNotFoundError:
                continue  # The service may retire a thread between these reads.
        found = []
        for pid in children:
            try:
                if Path(os.readlink(f"/proc/{pid}/exe")).name == name:
                    found.append(int(pid))
            except FileNotFoundError:
                continue
        return sorted(found)
    if os.name != "nt":
        raise RuntimeError("Idle process measurements support Windows and Linux")
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(Entry))
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = kernel.Process32FirstW.argtypes
    kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        found = []
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        present = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while present:
            if entry.th32ParentProcessID == parent and entry.szExeFile.lower() == name.lower():
                found.append(entry.th32ProcessID)
            present = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        return found
    finally:
        kernel.CloseHandle(snapshot)


def cpu_ns(pid: int) -> int:
    """Read actual kernel CPU counters; this is not an energy estimate."""
    if sys.platform == "linux":
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) * 1_000_000_000 // os.sysconf("SC_CLK_TCK")
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        creation, exit_time, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        return sum((value.dwHighDateTime << 32) | value.dwLowDateTime
                   for value in (kernel_time, user_time)) * 100
    finally:
        kernel.CloseHandle(handle)


def successful(report: dict, starts: int) -> None:
    status = report["status"]
    assert report["error_code"] == "" and status["state"] == "SUCCEEDED", report
    assert status["issued"] == status["committed"] == 3, report
    assert status["reserved_read_bytes"] == 2 * len(CONTENT), report
    terminal_hash = status["final_value_hash"]
    assert len(terminal_hash) == 64 and all(value in "0123456789abcdef" for value in terminal_hash), report
    assert report["metrics"]["process_starts"] == starts, report
    assert report["metrics"]["energy_measured"] is False, report
    want_mechanism = "windows_job_object" if os.name == "nt" else "linux_cgroup_v2"
    assert report["metrics"]["kernel_limit_mechanism"] == want_mechanism, report
    for field in ("host_cpu_time_ns", "swyp_cpu_time_ns", "verifier_cpu_time_ns",
                  "host_peak_rss_bytes", "swyp_peak_rss_bytes", "verifier_peak_rss_bytes"):
        assert report["metrics"][field] >= 0, report


def execute_gate(args: argparse.Namespace, directory: Path) -> None:
    good = Fixture(args, directory, "success")
    good.config["plans"][0]["expected_value_hash"] = hashlib.sha256(
        encoded({"type": "u64", "value": str(2 * len(CONTENT))})).hexdigest()
    positive = good.run(True)
    successful(positive, 3)
    print("MEASURE supervisor plan: " + json.dumps(positive["metrics"], sort_keys=True))
    assert len(committed_events(good.journal)) == 3
    journal = events(good.journal)
    decisions = [event["data"] for event in journal if event["type"] == "verification.recorded"]
    assert len(decisions) == 3 and all(value["decision"] == "PASSED" for value in decisions), decisions
    assert all(value["verifier_id"] == "integration-verifier" for value in decisions), decisions
    recovered = good.run(True, recover=True)
    assert recovered["recovery"]["outcome"] == "terminal" and recovered["status"]["state"] == "SUCCEEDED", recovered
    assert recovered["metrics"]["process_starts"] == 0 and recovered["recovery"]["continuation_resumed"] is False, recovered
    replay = good.run(False)
    assert replay["error_code"] == "recovery_required" and replay["status"]["state"] == "SUCCEEDED", replay
    assert replay["metrics"]["process_starts"] == 1, replay
    assert len(committed_events(good.journal)) == 3
    original = copy.deepcopy(good.config)
    for mutation in ("scope", "read_budget", "effect_budget", "kernel_cpu", "kernel_memory", "kernel_processes"):
        good.config = copy.deepcopy(original)
        plan = good.config["plans"][0]
        if mutation == "scope":
            plan["scopes"][0]["max_read_bytes"] += 1
        elif mutation == "read_budget":
            plan["max_read_bytes"] += 1
        elif mutation == "effect_budget":
            plan["max_effects"] += 1
        elif mutation == "kernel_cpu":
            good.config["kernel_cpu_percent"] -= 1
        elif mutation == "kernel_memory":
            good.config["kernel_memory_limit_bytes"] -= 1 << 20
        else:
            good.config["kernel_max_processes"] -= 1
        assert good.run(False)["error_code"] == "policy_changed", mutation
        assert len(committed_events(good.journal)) == 3
    good.config = copy.deepcopy(original)
    good.config["kernel_cpu_percent"] -= 1
    recovery_changed = good.run(False, recover=True)
    assert recovery_changed["error_code"] == "policy_changed" and recovery_changed["metrics"]["process_starts"] == 0, recovery_changed
    good.config = copy.deepcopy(original)
    print("PASS supervisor: scoped reads/clock, independent verification, durable commits, replay/policy/resource-policy refusal")

    budget = Fixture(args, directory, "total-read-budget")
    budget.config["plans"][0]["max_read_bytes"] = len(CONTENT)
    report = budget.run(False)
    assert report["status"]["state"] == "FAILED" and report["status"]["committed"] == 1, report
    assert report["status"]["reserved_read_bytes"] == len(CONTENT), report
    assert len(committed_events(budget.journal)) == 1
    missing = Fixture(args, directory, "missing-scope")
    missing.config["plans"][0]["scopes"] = []
    missing.run(False)
    assert not committed_events(missing.journal)
    rejected = Fixture(args, directory, "rejected-key")
    trust = Path(rejected.config["trust_registry"])
    registry = json.loads(trust.read_text(encoding="utf-8"))
    registry["keys"]["integration-test-key"]["revoked"] = True
    write_json(trust, registry)
    report = rejected.run(False)
    assert report["error_code"] == "verification_failed" and report["status"]["committed"] == 0, report
    assert not committed_events(rejected.journal)
    mismatch = Fixture(args, directory, "wrong-final-value")
    mismatch.config["plans"][0]["expected_value_hash"] = "0" * 64
    report = mismatch.run(False)
    assert report["status"]["state"] == "FAILED" and report["status"]["final_value_hash"] == "", report
    assert report["status"]["committed"] == 3, report
    print("PASS supervisor: cumulative read reservation, absent scope, rejected trust, final-value expectation")

    fixture = Fixture(args, directory, "service")
    source = Path(fixture.config["plans"][0]["source"])
    fixture.config["plans"] = [fixture.plan("service-first", source), fixture.plan("service-second", source)]
    for plan in fixture.config["plans"]:
        plan["expected_value_hash"] = hashlib.sha256(
            encoded({"type": "u64", "value": str(2 * len(CONTENT))})).hexdigest()
    service = Service(fixture)
    try:
        ready = service.frame()
        assert ready["protocol_version"] == 1 and ready["type"] == "ready", ready
        base = ready["budget"]
        service.send({"op": "signals", "signals": {"on_battery": True, "battery_percent": 10}})
        paused = service.frame()
        assert paused["type"] == "budget" and paused["budget"]["paused"] is True, paused
        assert paused["budget"]["max_cpu_percent"] <= base["max_cpu_percent"], paused
        service.send({"op": "signals", "signals": {}})
        resumed = service.frame()
        assert resumed["type"] == "budget" and resumed["budget"] == base, resumed
        service.send({"op": "status", "plan_id": "service-first"})
        status = service.frame()
        assert status["error_code"] == "not_started" and "status" not in status, status
        assert status["metrics"]["process_starts"] == 0, status
        assert not list(Path(fixture.config["ledger_directory"]).iterdir()), "status created a ledger"
        service.send({"op": "run", "plan_id": "service-first"})
        successful(service.frame(), 3)
        verifier_pids = child_pids(service.process.pid, args.verifier)
        assert len(verifier_pids) == 1, verifier_pids
        measured = {"supervisor": service.process.pid, "verifier": verifier_pids[0]}
        before = {name: cpu_ns(pid) for name, pid in measured.items()}
        started = time.monotonic_ns()
        time.sleep(2)
        elapsed = time.monotonic_ns() - started
        delta = {name: cpu_ns(pid) - before[name] for name, pid in measured.items()}
        assert all(0 <= value < 500_000_000 for value in delta.values()), delta
        assert child_pids(service.process.pid, args.verifier) == verifier_pids, "idle verifier restarted"
        print("MEASURE supervisor idle: " + json.dumps({"wall_time_ns": elapsed, "pids": measured,
                                                       "cpu_time_ns": delta, "energy_measured": False},
                                                      sort_keys=True))
        service.send({"op": "run", "plan_id": "service-second"})
        successful(service.frame(), 2)
        assert child_pids(service.process.pid, args.verifier) == verifier_pids, "verifier restarted between plans"
        source.unlink()
        service.send({"op": "status", "plan_id": "service-first"})
        status = service.frame()
        assert status["error_code"] == "" and status["status"]["state"] == "SUCCEEDED" and status["status"]["committed"] == 3, status
        assert status["metrics"]["process_starts"] == 0, status
        service.send({"op": "recover", "plan_id": "service-first"})
        recovered = service.frame()
        assert recovered["error_code"] == "" and recovered["recovery"]["outcome"] == "terminal", recovered
        assert recovered["metrics"]["process_starts"] == 0, recovered
        assert len(committed_events(fixture.journal)) == 6
        transitions = [event for event in events(fixture.journal) if event["type"] == "resource.state_recorded"]
        assert len(transitions) >= 3, transitions
        service.shutdown()
        print("PASS supervisor service: ready, budgets, status without source/child, two plans, reused verifier, bounded idle CPU, shutdown")
    finally:
        service.close()


def main() -> None:
    if not __debug__:
        raise RuntimeError("The integration gate requires assertions; disable -O/PYTHONOPTIMIZE.")
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("swyp", "supervisor", "verifier"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--cgroup-root", default=os.environ.get("NEXUS_TEST_CGROUP_ROOT", ""))
    args = parser.parse_args()
    for option in ("swyp", "supervisor", "verifier"):
        executable = Path(getattr(args, option)).resolve(strict=True)
        assert executable.is_file(), executable
        setattr(args, option, str(executable))
    with tempfile.TemporaryDirectory(prefix="nexus-supervisor-gate-") as temporary:
        execute_gate(args, Path(temporary).resolve())
    if sys.platform == "linux":
        root = Path(args.cgroup_root)
        assert args.cgroup_root and root.is_absolute() and root != Path("/sys/fs/cgroup"), "Linux requires an explicit delegated cgroup root"
    print("PASS: supervisor v2 integration gate")


if __name__ == "__main__":
    main()
