"""Linux task-owned subreaper/pidfd supervision; never a general process service."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time

VERSION = "linux-subreaper-pidfd-v1"
FORMAT = "imc-supervisor-capability-v1"
MAX_PROCESSES = 1024
MAX_THREADS = 4096
MAX_FRAME = 4096
MAX_RECEIPT = 512 * 1024
LOG_LIMIT = 8 * 1024 * 1024


def source_pins():
    root = Path(__file__).resolve().parent
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in ("probe.py", "containment.py")}


def _decode(raw, limit=MAX_FRAME):
    if len(raw) > limit:
        raise ValueError("containment frame exceeds cap")
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("duplicate containment field")
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=pairs,
                       parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite frame")))
    if not isinstance(value, dict):
        raise ValueError("containment frame must be object")
    return value


def _send(sock, value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    if len(raw) > MAX_RECEIPT:
        raise ValueError("containment receipt exceeds cap")
    sock.sendall(raw + b"\n")


def _receive(sock, limit=MAX_FRAME):
    raw = bytearray()
    while True:
        chunk = sock.recv(min(4096, limit + 1 - len(raw)))
        if not chunk:
            raise ValueError("containment channel closed")
        raw.extend(chunk)
        if len(raw) > limit or (b"\n" in raw and not raw.endswith(b"\n")):
            raise ValueError("invalid containment framing")
        if raw.endswith(b"\n"):
            return _decode(raw[:-1], limit)


def _identity(pid):
    # Only explicitly owned pid/ancestor paths are inspected; no global /proc scan.
    text = Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    return int(fields[1]), int(fields[19])


def _children(pid):
    result = set()
    tasks = list(Path(f"/proc/{pid}/task").iterdir())
    if len(tasks) > MAX_THREADS:
        raise ValueError("owned task thread cap exceeded")
    for task in tasks:
        try:
            raw = (task / "children").read_bytes()
        except FileNotFoundError:
            continue
        if len(raw) > 64 * 1024:
            raise ValueError("owned child metadata cap exceeded")
        result.update(int(value) for value in raw.split())
    return result


def _kernel_ready(parent_pid):
    if not sys.platform.startswith("linux") or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ValueError("Linux subreaper and pidfd signals required")
    libc = ctypes.CDLL(None, use_errno=True)
    # Signal handlers are installed before PDEATHSIG. A parent-death race refuses admission.
    if libc.prctl(36, 1, 0, 0, 0) or libc.prctl(1, signal.SIGTERM, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "subreaper/parent-death setup refused")
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) or enabled.value != 1:
        raise ValueError("subreaper not verified by kernel")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    if os.getppid() != parent_pid:
        raise ValueError("scope parent died before admission")
    return {"format": FORMAT, "capability_version": VERSION,
            "mechanism": "isolated-owned-subreaper", "source_sha256": source_pins(),
            "helper_pid": os.getpid(), "helper_starttime": _identity(os.getpid())[1],
            "kernel_subreaper_verified": True, "pidfd_signals_verified": True}


def scrubbed_environment(threads):
    # Tool/runtime paths only. Credentials, arbitrary PYTHONPATH/LD_PRELOAD and controller keys are absent.
    allowed = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CUDA_VISIBLE_DEVICES",
               "LD_LIBRARY_PATH", "NCCL_SOCKET_IFNAME", "GLOO_SOCKET_IFNAME")
    env = {name: os.environ[name] for name in allowed if name in os.environ}
    env.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads),
               OPENBLAS_NUM_THREADS=str(threads), PYTHONUNBUFFERED="1", PYTHONNOUSERSITE="1",
               PYTHONDONTWRITEBYTECODE="1", CUBLAS_WORKSPACE_CONFIG=":4096:8")
    return env


def validate_binding(binding):
    if binding is None:
        return None
    required = {"config_identity_sha256", "worker_source_path", "worker_source_sha256"}
    if not isinstance(binding, dict) or set(binding) not in (required, required | {"worker_argv_sha256"}):
        raise ValueError("exact containment worker binding required")
    for key in ("config_identity_sha256", "worker_source_sha256", *(["worker_argv_sha256"] if "worker_argv_sha256" in binding else [])):
        value = binding[key]
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("invalid containment binding hash")
    worker = Path(binding["worker_source_path"])
    if not worker.is_absolute() or len(str(worker).encode()) > 2048 or worker.is_symlink() or not worker.is_file() or worker.suffix != ".py":
        raise ValueError("absolute public worker source required")
    if hashlib.sha256(worker.read_bytes()).hexdigest() != binding["worker_source_sha256"]:
        raise ValueError("worker source pin drift")
    return dict(binding)


def assert_current_containment(*, expected_config_identity, expected_source_sha256,
                               expected_worker_source_sha256=None, expected_worker_source_path=None,
                               required_remaining_seconds=0):
    """Live, kernel-peer/owned-membership assertion. An address or caller bool grants nothing."""
    if not sys.platform.startswith("linux"):
        raise ValueError("strict containment is Linux only")
    if type(required_remaining_seconds) not in (int, float) or not math.isfinite(required_remaining_seconds) or required_remaining_seconds < 0:
        raise ValueError("invalid containment remaining reserve")
    endpoint = os.environ.get("IMC_CONTAINMENT_SOCKET", "")
    if not endpoint or len(endpoint.encode()) > 107:
        raise ValueError("live owned containment endpoint missing")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(2)
        channel.connect(endpoint)
        server_pid, _, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        _send(channel, {"format": "imc-containment-assertion-v1", "config_identity_sha256": expected_config_identity})
        reply = _receive(channel)
    expected_keys = {"format", "capability_version", "source_sha256", "helper_pid", "helper_starttime",
                     "peer_pid", "peer_starttime", "config_identity_sha256", "worker_source_path",
                     "worker_source_sha256", "worker_argv_sha256", "argv_sha256", "deadline_unix", "hard_end_monotonic"}
    if set(reply) != expected_keys or reply["format"] != "imc-containment-admission-v1" or reply["capability_version"] != VERSION:
        raise ValueError("containment admission denied/malformed")
    if (reply["helper_pid"] != server_pid or reply["helper_starttime"] != _identity(server_pid)[1]
            or reply["peer_pid"] != os.getpid() or reply["peer_starttime"] != _identity(os.getpid())[1]
            or reply["source_sha256"] != expected_source_sha256
            or reply["config_identity_sha256"] != expected_config_identity
            or (expected_worker_source_path is not None and reply["worker_source_path"] != str(expected_worker_source_path))
            or (expected_worker_source_sha256 is not None and reply["worker_source_sha256"] != expected_worker_source_sha256)):
        raise ValueError("containment identity/source/config mismatch")
    remaining = min(reply["deadline_unix"] - time.time(), reply["hard_end_monotonic"] - time.monotonic())
    if remaining <= required_remaining_seconds:
        raise ValueError("containment remaining budget insufficient")
    return reply


def _worker(channel, log_fd, parent_pid):
    stopped = {"reason": None}
    def stop(sig, frame):
        stopped["reason"] = "parent-death-or-cancel"
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ready = _kernel_ready(parent_pid)
    _send(channel, ready)
    request = _receive(channel, 128 * 1024)
    if request == {"command": "probe"}:
        _send(channel, {**ready, "readiness_verified": True, "no_children_verified": True})
        return 0
    keys = {"command", "argv", "cwd", "deadline_unix", "hard_end_monotonic", "phase_end_monotonic",
            "teardown_seconds", "threads", "binding", "log_limit"}
    if set(request) != keys or request["command"] != "run":
        raise ValueError("unknown scope request")
    argv = request["argv"]
    if (not isinstance(argv, list) or not argv or len(argv) > 256 or any(not isinstance(a, str) or not a or "\0" in a or "\n" in a or "\r" in a or len(a.encode()) > 8192 for a in argv)):
        raise ValueError("invalid exact worker argv")
    for key in ("deadline_unix", "hard_end_monotonic", "phase_end_monotonic", "teardown_seconds"):
        if type(request[key]) not in (int, float) or not math.isfinite(request[key]) or request[key] <= 0:
            raise ValueError("invalid scope deadline")
    if type(request["threads"]) is not int or not 1 <= request["threads"] <= 64:
        raise ValueError("invalid thread cap")
    if type(request["log_limit"]) is not int or not 1 <= request["log_limit"] <= LOG_LIMIT:
        raise ValueError("invalid log cap")
    binding = validate_binding(request["binding"])
    argv_sha = hashlib.sha256(json.dumps(argv, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    records = {}
    selector = selectors.DefaultSelector()
    selector.register(channel, selectors.EVENT_READ, "parent")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    owned_dir = tempfile.TemporaryDirectory(prefix="imc-owned-scope-")
    endpoint = str(Path(owned_dir.name) / "admission.sock")
    server.bind(endpoint); server.listen(16); server.setblocking(False)
    selector.register(server, selectors.EVENT_READ, "admission")
    process = None
    no_children = False
    timed_out = False
    log_bytes = 0
    error = None
    cleanup_end = None

    def remember(pid, parent):
        if pid in records:
            if _identity(pid)[1] != records[pid]["starttime"]:
                raise ValueError("retained owned PID identity changed")
            return
        if len(records) >= MAX_PROCESSES:
            raise ValueError("owned process cap exceeded")
        fd = os.pidfd_open(pid)
        try:
            ppid, starttime = _identity(pid)
            if ppid != parent:
                raise ValueError("owned parent identity changed during pidfd admission")
            records[pid] = {"pid": pid, "starttime": starttime, "parent_pid": parent,
                            "fd": fd, "exit_verified": False, "reaped": False, "returncode": None}
        except BaseException:
            os.close(fd)
            raise

    def refresh():
        pending = [os.getpid()]
        seen = set()
        while pending:
            parent = pending.pop()
            if parent in seen:
                continue
            seen.add(parent)
            if parent != os.getpid():
                record = records[parent]
                if select.select([record["fd"]], [], [], 0)[0]:
                    record["exit_verified"] = True
                    continue
                if _identity(parent)[1] != record["starttime"]:
                    raise ValueError("retained owned parent identity changed before discovery")
            try:
                children = _children(parent)
            except FileNotFoundError:
                continue
            for pid in children:
                try:
                    remember(pid, parent)
                except ProcessLookupError:
                    continue
                except FileNotFoundError:
                    continue
                pending.append(pid)
        for record in records.values():
            # A held pidfd cannot signal a reused unrelated PID.
            if select.select([record["fd"]], [], [], 0)[0]:
                record["exit_verified"] = True

    def reap():
        nonlocal no_children
        while True:
            try:
                event = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                no_children = True
                return
            if event is None:
                no_children = False
                return
            pid = event.si_pid
            remember(pid, os.getpid())
            got, status = os.waitpid(pid, os.WNOHANG)
            if got:
                records[pid].update(exit_verified=True, reaped=True, returncode=os.waitstatus_to_exitcode(status))
                if process is not None and pid == process.pid:
                    process.returncode = records[pid]["returncode"]

    def kill_owned(sig):
        refresh()
        for record in records.values():
            if not record["exit_verified"]:
                try:
                    signal.pidfd_send_signal(record["fd"], sig)
                except ProcessLookupError:
                    pass

    def assertion(client):
        client.settimeout(0.05)
        peer, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        query = _receive(client)
        if set(query) != {"format", "config_identity_sha256"} or query["format"] != "imc-containment-assertion-v1":
            raise ValueError("invalid child assertion")
        refresh()
        if (binding is None or "worker_argv_sha256" not in binding or stopped["reason"] is not None or cleanup_end is not None or uid != os.getuid()
                or peer not in records or records[peer]["exit_verified"]
                or _identity(peer)[1] != records[peer]["starttime"]
                or query["config_identity_sha256"] != binding["config_identity_sha256"]):
            raise ValueError("peer is not a live admitted worker in this scope")
        with Path(f"/proc/{peer}/cmdline").open("rb") as handle:
            raw_argv = handle.read(16 * 1024 + 1)
        if len(raw_argv) > 16 * 1024 or not raw_argv.endswith(b"\0"):
            raise ValueError("owned worker argv cap/framing mismatch")
        peer_argv = [arg.decode("utf-8", errors="strict") for arg in raw_argv[:-1].split(b"\0")]
        actual_argv = hashlib.sha256(json.dumps(peer_argv, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if actual_argv != binding["worker_argv_sha256"]:
            raise ValueError("owned worker is not the exact issued canonical argv")
        if time.time() >= request["deadline_unix"] or time.monotonic() >= request["phase_end_monotonic"]:
            raise ValueError("scope expired before child admission")
        _send(client, {"format": "imc-containment-admission-v1", "capability_version": VERSION,
                       "source_sha256": ready["source_sha256"], "helper_pid": ready["helper_pid"],
                       "helper_starttime": ready["helper_starttime"], "peer_pid": peer,
                       "peer_starttime": records[peer]["starttime"], **binding,
                       "argv_sha256": argv_sha, "deadline_unix": request["deadline_unix"],
                       "hard_end_monotonic": request["hard_end_monotonic"]})

    try:
        if stopped["reason"] or time.time() >= request["deadline_unix"] or time.monotonic() >= request["phase_end_monotonic"]:
            raise ValueError("deadline/parent unavailable before worker spawn")
        env = scrubbed_environment(request["threads"]); env["IMC_CONTAINMENT_SOCKET"] = endpoint
        process = subprocess.Popen(argv, cwd=request["cwd"], env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        remember(process.pid, os.getpid())
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "log")
        while True:
            refresh(); reap()
            now = time.monotonic()
            expired = now >= request["phase_end_monotonic"] or time.time() >= request["deadline_unix"] - request["teardown_seconds"]
            if expired and process.returncode is None:
                timed_out = True; stopped["reason"] = stopped["reason"] or "deadline"
            if process.returncode is not None or stopped["reason"]:
                if cleanup_end is None:
                    cleanup_end = min(now + request["teardown_seconds"], request["hard_end_monotonic"], now + max(0, request["deadline_unix"] - time.time()))
                    kill_owned(signal.SIGTERM)
                if now >= cleanup_end - min(0.1, request["teardown_seconds"] / 2):
                    kill_owned(signal.SIGKILL)
                if no_children and all(r["exit_verified"] for r in records.values()):
                    break
                if now >= cleanup_end:
                    error = "owned cleanup deadline exhausted"; break
            for key, _ in selector.select(0.01):
                if key.data == "parent":
                    # No post-launch mutation protocol: only EOF/cancellation is accepted.
                    data = channel.recv(4096)
                    stopped["reason"] = "parent-channel-closed" if not data else "parent-cancel"
                    selector.unregister(channel)
                elif key.data == "log":
                    data = os.read(process.stdout.fileno(), 8192)
                    if not data:
                        selector.unregister(process.stdout)
                    else:
                        room = max(0, request["log_limit"] - log_bytes)
                        if room: os.write(log_fd, data[:room])
                        log_bytes += min(room, len(data))
                        if len(data) > room:
                            stopped["reason"] = "log-byte-cap"; error = "worker log exceeds cap"
                else:
                    client, _ = server.accept()
                    with client:
                        try: assertion(client)
                        except (OSError, ValueError):
                            try: _send(client, {"format": "imc-containment-denied-v1"})
                            except OSError: pass
        refresh(); reap()
    except BaseException as exc:
        error = str(exc); stopped["reason"] = stopped["reason"] or "scope-error"
        for record in records.values():
            try:
                signal.pidfd_send_signal(record["fd"], signal.SIGKILL)
            except ProcessLookupError:
                record["exit_verified"] = True
        end = min(time.monotonic() + request["teardown_seconds"], request["hard_end_monotonic"],
                  time.monotonic() + max(0, request["deadline_unix"] - time.time()))
        while time.monotonic() < end:
            try:
                # Capacity/metadata failure must still stop descendants. Kill only
                # direct kernel-owned children, then reap/adopt and repeat. Never
                # expand receipt metadata past the cap or claim success on this path.
                for pid in _children(os.getpid()):
                    try:
                        fd = os.pidfd_open(pid)
                    except (ProcessLookupError, FileNotFoundError):
                        continue
                    try:
                        if _identity(pid)[0] != os.getpid():
                            raise ValueError("emergency owned parent changed")
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except (ProcessLookupError, FileNotFoundError):
                        pass
                    finally:
                        os.close(fd)
                try:
                    while True:
                        pid, status = os.waitpid(-1, os.WNOHANG)
                        if pid == 0: break
                        if pid in records:
                            records[pid].update(exit_verified=True, reaped=True, returncode=os.waitstatus_to_exitcode(status))
                        if process is not None and pid == process.pid:
                            process.returncode = os.waitstatus_to_exitcode(status)
                except ChildProcessError:
                    no_children = True
                if no_children: break
            except (OSError, ValueError):
                break
            time.sleep(0.005)
    finally:
        if process is not None and process.stdout is not None:
            process.stdout.close()
        selector.close(); server.close(); owned_dir.cleanup()
    metadata_complete = error is None
    cleanup = no_children and metadata_complete and all(r["exit_verified"] for r in records.values())
    receipt = {**ready, "format": "imc-supervised-scope-v1", "argv_sha256": argv_sha, "binding": binding,
               "pid": process.pid if process else None, "returncode": process.returncode if process else None,
               "timed_out": timed_out, "stop_reason": stopped["reason"], "error": error,
               "log_bytes": log_bytes, "no_children_verified": no_children,
               "metadata_complete": metadata_complete, "cleanup_verified": cleanup,
               "owned_processes": [{k: v for k, v in r.items() if k != "fd"} for r in records.values()]}
    for record in records.values(): os.close(record["fd"])
    _send(channel, receipt)
    return 0 if cleanup else 1


def run_scope(request=None, *, log_path=None):
    if not sys.platform.startswith("linux"):
        raise ValueError("strict scope execution requires Linux; no PG-only fallback")
    expected = source_pins()
    if request is not None:
        fields = {"command", "argv", "cwd", "deadline_unix", "hard_end_monotonic", "phase_end_monotonic",
                  "teardown_seconds", "threads", "binding", "log_limit"}
        if not isinstance(request, dict) or set(request) != fields or request["command"] != "run":
            raise ValueError("exact scope request fields required")
        for key in ("deadline_unix", "hard_end_monotonic", "phase_end_monotonic", "teardown_seconds"):
            if type(request[key]) not in (int, float) or not math.isfinite(request[key]) or request[key] <= 0:
                raise ValueError("finite positive scope deadlines required")
    parent, child = socket.socketpair()
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600) if log_path else os.open(os.devnull, os.O_WRONLY)
    helper = None
    helper_fd = None
    start = time.monotonic()
    try:
        helper = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).resolve()),
                                   "--worker", str(child.fileno()), "--log-fd", str(log_fd), "--parent-pid", str(os.getpid())],
                                  pass_fds=(child.fileno(), log_fd), env=scrubbed_environment(1),
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  start_new_session=True)
        child.close()
        helper_fd = os.pidfd_open(helper.pid)
        parent.settimeout(2)
        ready = _receive(parent)
        if (ready.get("capability_version") != VERSION or ready.get("source_sha256") != expected
                or ready.get("helper_pid") != helper.pid or ready.get("kernel_subreaper_verified") is not True
                or ready.get("pidfd_signals_verified") is not True):
            raise ValueError("helper kernel/source handshake failed")
        _send(parent, {"command": "probe"} if request is None else request)
        timeout = 2 if request is None else max(0.001, min(request["hard_end_monotonic"] - time.monotonic(), request["deadline_unix"] - time.time()))
        parent.settimeout(timeout)
        result = _receive(parent, MAX_RECEIPT)
        remaining = 2 if request is None else min(request["hard_end_monotonic"] - time.monotonic(), request["deadline_unix"] - time.time())
        helper.wait(timeout=max(0.001, remaining))
        if result.get("source_sha256") != expected or source_pins() != expected:
            raise ValueError("scope source drift")
        result["scope_worker_exited"] = True
        result["elapsed_seconds"] = time.monotonic() - start
        return result
    finally:
        parent.close(); child.close(); os.close(log_fd)
        if helper is not None and helper.poll() is None:
            # Helper catches TERM and performs owned cleanup; no killing an unverified PID.
            if helper_fd is not None:
                try: signal.pidfd_send_signal(helper_fd, signal.SIGTERM)
                except ProcessLookupError: pass
            else:
                # pidfd acquisition failed before the run request: the unreaped
                # direct Popen child cannot have its PID reused; workload is unadmitted.
                helper.terminate()
            reserve = 2 if request is None else max(0, min(request["hard_end_monotonic"] - time.monotonic(), request["deadline_unix"] - time.time()))
            try: helper.wait(timeout=reserve)
            except subprocess.TimeoutExpired: pass
        if helper_fd is not None:
            os.close(helper_fd)


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--worker", type=int, required=True)
    parser.add_argument("--log-fd", type=int, required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    with socket.socket(fileno=args.worker) as channel:
        return _worker(channel, args.log_fd, args.parent_pid)


if __name__ == "__main__":
    try: raise SystemExit(main())
    except (OSError, ValueError): raise SystemExit(2)
