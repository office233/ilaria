"""Local CPU/fake-process proof for the NCCL bootstrap supervisor.

These tests neither initialize CUDA nor establish eight-GPU/NCCL evidence.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import signal
import hashlib
import os
import socket
import threading
import time
if not hasattr(signal, "SIGKILL"):
    signal.SIGKILL = 9  # Fake-process tests only; execution is Linux-only.
import subprocess
import types

import pytest


PROBE_PATH = Path(__file__).with_name("probe.py")
SPEC = importlib.util.spec_from_file_location("imc_nccl_bootstrap_probe", PROBE_PATH)
assert SPEC is not None and SPEC.loader is not None
probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


def native_supervisor(seconds=8, phase=3, binding=None):
    return probe.Supervisor(probe.Limits(datetime.now(timezone.utc) + timedelta(seconds=seconds),
                                        seconds, phase, 2), containment_binding=binding)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
@pytest.mark.parametrize("launcher_killed", [False, True])
def test_native_setsid_rank_stops_even_when_launcher_exits(tmp_path, launcher_killed):
    ticks = tmp_path / "ticks"
    pidfile = tmp_path / "rank.pid"
    child = ("import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);"
             f"p=Path({str(ticks)!r});end=time.monotonic()+10;\n"
             "while time.monotonic()<end:\n p.write_text(str(time.monotonic()));time.sleep(.005)")
    launcher = ("import subprocess,sys,time,os,signal;from pathlib import Path;"
                f"p=subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True);"
                f"Path({str(pidfile)!r}).write_text(str(p.pid));time.sleep(.05);"
                + ("os.kill(os.getpid(),signal.SIGKILL)" if launcher_killed else "sys.exit(0)"))
    observed = native_supervisor().run([sys.executable, "-c", launcher], tmp_path, tmp_path / "escape.log")
    (tmp_path / "scope-receipt.json").write_text(json.dumps(observed, sort_keys=True))
    rank = int(pidfile.read_text())
    assert observed["cleanup_verified"] and observed["no_children_verified"] and observed["scope_worker_exited"]
    assert any(p["pid"] == rank and p["exit_verified"] and p["reaped"] for p in observed["owned_processes"])
    assert not Path(f"/proc/{rank}").exists()
    before = ticks.read_text(); time.sleep(.03); assert ticks.read_text() == before
    assert observed["status"] == ("FAIL" if launcher_killed else "PASS")


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_native_stalled_cpu_deadline_and_cumulative_budget(tmp_path):
    supervisor = native_supervisor(seconds=4, phase=.35)
    worker = tmp_path / "busy.py"
    worker.write_text("import signal;signal.signal(signal.SIGTERM,signal.SIG_IGN)\nwhile True: pass")
    observed = supervisor.run([sys.executable, str(worker)],
                              tmp_path, tmp_path / "cpu.log")
    assert observed["status"] == "FAIL" and observed["timed_out"]
    assert observed["cleanup_verified"] and observed["no_children_verified"]
    assert observed["elapsed_seconds"] < 4
    assert not Path(f'/proc/{observed["pid"]}').exists()


def test_windows_strict_path_refuses_before_spawn(monkeypatch, tmp_path):
    helper = probe.containment_module()
    monkeypatch.setattr(helper.sys, "platform", "win32")
    with pytest.raises(ValueError, match="requires Linux"):
        helper.run_scope(log_path=tmp_path / "never.log")
    assert not (tmp_path / "never.log").exists()


def test_scope_rejects_newline_argv_and_plain_cleanup_boolean(tmp_path):
    supervisor = native_supervisor()
    with pytest.raises(ValueError, match="bounded"):
        supervisor.run(["python\nother"], tmp_path, tmp_path / "never.log")
    supervisor.scope_runner = lambda *a, **k: {"returncode": 0, "timed_out": False, "cleanup_verified": True}
    assert supervisor.run(["synthetic"], tmp_path, tmp_path / "mock.log")["status"] == "FAIL"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_native_capability_and_live_admission_are_source_bound(tmp_path):
    helper_path = PROBE_PATH.with_name("containment.py").resolve()
    worker = tmp_path / "worker.py"
    worker.write_text("# synthetic public worker\n")
    binding = {"config_identity_sha256": "c" * 64, "worker_source_path": str(worker),
               "worker_source_sha256": hashlib.sha256(worker.read_bytes()).hexdigest()}
    supervisor = native_supervisor(binding=binding)
    capability = supervisor.strict_capability()
    (tmp_path / "capability.json").write_text(json.dumps(capability, sort_keys=True))
    assert capability["capability_version"] == "linux-subreaper-pidfd-v1"
    assert capability["readiness_verified"] and capability["kernel_subreaper_verified"]
    code = ("import importlib.util,json,os;from pathlib import Path;"
            f"p=Path({str(helper_path)!r});s=importlib.util.spec_from_file_location('scope',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            f"r=m.assert_current_containment(expected_config_identity={'c'*64!r},expected_source_sha256={capability['source_sha256']!r},"
            f"expected_worker_source_sha256={binding['worker_source_sha256']!r},expected_worker_source_path={str(worker)!r},required_remaining_seconds=.1);"
            f"Path({str(tmp_path/'admission.json')!r}).write_text(json.dumps(r))")
    argv = [sys.executable, "-c", code]
    binding["worker_argv_sha256"] = hashlib.sha256(json.dumps(argv, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    supervisor.binding = supervisor.containment.validate_binding(binding)
    observed = supervisor.run(argv, tmp_path, tmp_path / "admission.log")
    (tmp_path / "scope-receipt.json").write_text(json.dumps(observed, sort_keys=True))
    assert observed["status"] == "PASS"
    admission = json.loads((tmp_path / "admission.json").read_text())
    assert admission["peer_pid"] == observed["pid"]
    assert admission["helper_pid"] == observed["helper_pid"]
    assert admission["argv_sha256"] == observed["argv_sha256"]
    assert admission["config_identity_sha256"] == binding["config_identity_sha256"]


def test_protocol_unknown_duplicate_and_cap_fields_rejected():
    helper = probe.containment_module()
    for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'[]', b'x' * 4097):
        with pytest.raises(ValueError): helper._decode(raw)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_unowned_peer_cannot_use_known_scope_socket(tmp_path):
    endpoint_file = tmp_path / "endpoint"
    worker = tmp_path / "worker.py"; worker.write_text("# public fixture\n")
    argv = [sys.executable, "-c", "import os,time;from pathlib import Path;"
            f"Path({str(endpoint_file)!r}).write_text(os.environ['IMC_CONTAINMENT_SOCKET']);time.sleep(.8)"]
    binding = {"config_identity_sha256": "d" * 64, "worker_source_path": str(worker),
               "worker_source_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
               "worker_argv_sha256": hashlib.sha256(json.dumps(argv, separators=(",", ":")).encode()).hexdigest()}
    supervisor = native_supervisor(binding=binding)
    observations = []
    thread = threading.Thread(target=lambda: observations.append(supervisor.run(argv, tmp_path, tmp_path / "unowned.log")))
    thread.start()
    try:
        end = time.monotonic() + 2
        while not endpoint_file.exists() and time.monotonic() < end: time.sleep(.005)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            channel.settimeout(1); channel.connect(endpoint_file.read_text())
            supervisor.containment._send(channel, {"format": "imc-containment-assertion-v1", "config_identity_sha256": "d" * 64})
            assert supervisor.containment._receive(channel) == {"format": "imc-containment-denied-v1"}
    finally:
        thread.join(6)
    assert not thread.is_alive() and observations[0]["status"] == "PASS"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_owned_peer_with_wrong_argv_binding_is_denied(tmp_path):
    worker = tmp_path / "worker.py"; worker.write_text("# public fixture\n")
    helper_path = PROBE_PATH.with_name("containment.py").resolve()
    code = ("import importlib.util;from pathlib import Path;"
            f"s=importlib.util.spec_from_file_location('scope',{str(helper_path)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            f"m.assert_current_containment(expected_config_identity={'e'*64!r},expected_source_sha256=m.source_pins())")
    binding = {"config_identity_sha256": "e" * 64, "worker_source_path": str(worker),
               "worker_source_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(), "worker_argv_sha256": "0" * 64}
    result = native_supervisor(binding=binding).run([sys.executable, "-c", code], tmp_path, tmp_path / "wrong.log")
    assert result["status"] == "FAIL" and result["cleanup_verified"]
    assert "admission denied" in (tmp_path / "wrong.log").read_text()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_scope_metadata_cap_failure_still_kills_detached_children(tmp_path):
    # Change a cap only inside the isolated helper fixture, not any product source.
    helper = PROBE_PATH.with_name("containment.py").resolve()
    child = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)"
    launcher = ("import subprocess,sys,time;"
                f"p=subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True);"
                "time.sleep(20)")
    driver = ("import importlib.util,socket,os,json,time;from pathlib import Path;"
              f"s=importlib.util.spec_from_file_location('scope',{str(helper)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.MAX_PROCESSES=1;"
              "a,b=socket.socketpair();fd=os.open(os.devnull,os.O_WRONLY);"
              "pid=os.fork();\n"
              "if pid==0:\n"
              " a.close();m._worker(b,fd,os.getppid());os._exit(0)\n"
              "b.close();a.settimeout(6);m._receive(a);"
              f"m._send(a,dict(command='run',argv=[{sys.executable!r},'-c',{launcher!r}],cwd={str(tmp_path)!r},deadline_unix=time.time()+6,hard_end_monotonic=time.monotonic()+6,phase_end_monotonic=time.monotonic()+3,teardown_seconds=2,threads=1,binding=None,log_limit=1024));"
              "r=m._receive(a,m.MAX_RECEIPT);_,status=os.waitpid(pid,0);"
              "assert os.waitstatus_to_exitcode(status)==0;print(json.dumps(r))")
    observed = subprocess.run([sys.executable, "-c", driver], capture_output=True, text=True, timeout=8)
    assert observed.returncode == 0, observed.stderr
    receipt = json.loads(observed.stdout)
    assert "process cap" in receipt["error"]
    assert receipt["no_children_verified"] and not receipt["cleanup_verified"] and not receipt["metadata_complete"]
    # The cap can fire between fork and any launcher-side PID publication. It
    # proves discovery of the second process; kernel ECHILD proves its cleanup.
    assert receipt["stop_reason"] == "scope-error"
    assert receipt["returncode"] < 0
    assert len(receipt["owned_processes"]) == 1
    launcher_record = receipt["owned_processes"][0]
    assert launcher_record["pid"] == receipt["pid"]
    assert launcher_record["exit_verified"] and launcher_record["reaped"]
    assert launcher_record["returncode"] == receipt["returncode"]
    (tmp_path / "scope-receipt.json").write_text(json.dumps(receipt, sort_keys=True))


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="actual Linux kernel containment")
def test_parent_death_stops_and_reaps_escaped_rank(tmp_path):
    ids = tmp_path / "owned.json"
    child = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)"
    launcher = ("import subprocess,sys,time,os,json;from pathlib import Path;"
                f"p=subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True);"
                f"Path({str(ids)!r}).write_text(json.dumps(dict(helper=os.getppid(),launcher=os.getpid(),rank=p.pid)));time.sleep(20)")
    outer = tmp_path / "outer.py"
    outer.write_text("import importlib.util,sys\nfrom pathlib import Path\nfrom datetime import datetime,timedelta,timezone\n"
                     f"s=importlib.util.spec_from_file_location('probe',{str(PROBE_PATH.resolve())!r});m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)\n"
                     f"m.Supervisor(m.Limits(datetime.now(timezone.utc)+timedelta(seconds=8),8,4,2)).run([sys.executable,'-c',{launcher!r}],Path({str(tmp_path)!r}),Path({str(tmp_path/'death.log')!r}))\n")
    driver = tmp_path / "driver.py"
    driver.write_text("import ctypes,json,os,select,signal,subprocess,sys,time\nfrom pathlib import Path\n"
                      "assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0\n"
                      f"p=subprocess.Popen([sys.executable,{str(outer)!r}]);fds=[]\n"
                      "try:\n"
                      " end=time.monotonic()+3\n"
                      f" while not Path({str(ids)!r}).exists() and time.monotonic()<end:time.sleep(.005)\n"
                      f" ids=json.loads(Path({str(ids)!r}).read_text());client=os.pidfd_open(p.pid);helper=os.pidfd_open(ids['helper']);rank=os.pidfd_open(ids['rank']);fds=[client,helper,rank]\n"
                      " signal.pidfd_send_signal(client,signal.SIGKILL);p.wait();start=time.monotonic()\n"
                      " assert select.select([helper],[],[],3.5)[0], 'helper survived parent death'\n"
                      " assert select.select([rank],[],[],0)[0], 'setsid rank survived helper cleanup'\n"
                      " os.waitpid(ids['helper'],0)\n"
                      " try:os.waitpid(-1,os.WNOHANG)\n"
                      " except ChildProcessError:empty=True\n"
                      " else:empty=False\n"
                      " assert empty\n"
                      " print(json.dumps(dict(parent_death_cleanup=True,rank_exited=True,helper_exited=True,no_owned_children=True,seconds=time.monotonic()-start)))\n"
                      "finally:\n"
                      " for fd in fds:\n"
                      "  try:signal.pidfd_send_signal(fd,signal.SIGKILL)\n"
                      "  except ProcessLookupError:pass\n"
                      "  os.close(fd)\n")
    result = subprocess.run([sys.executable, str(driver)], capture_output=True, text=True, timeout=8)
    assert result.returncode == 0, result.stderr
    proof = json.loads(result.stdout)
    (tmp_path / "parent-death-proof.json").write_text(json.dumps(proof, sort_keys=True))
    assert proof["parent_death_cleanup"] and proof["no_owned_children"]
    assert proof["seconds"] < 3.5


def identity():
    return {
        "format": "imc-nccl-identity-v1",
        "world_size": 8,
        "backend": "nccl",
        "all_reduce_sum": 28,
        "ranks": [
            {
                "rank": rank,
                "local_rank": rank,
                "device_index": rank,
                "gpu_uuid": f"GPU-test-{rank}",
                "name": "NVIDIA H200",
                "vram_bytes": 141 * 1024**3,
                "compute_major": 9,
                "bf16": True,
            }
            for rank in range(8)
        ],
    }


def test_identity_accepts_complete_eight_rank_nccl_receipt():
    probe.validate_identity(identity())


@pytest.mark.parametrize("field,value", [("world_size", 8.0), ("all_reduce_sum", 28.0)])
def test_identity_world_and_collective_result_require_exact_integers(field, value):
    result = identity()
    result[field] = value
    with pytest.raises(ValueError):
        probe.validate_identity(result)


@pytest.mark.parametrize("field,value", [
    ("format", "unknown"), ("backend", "gloo"), ("world_size", 7),
    ("world_size", True), ("ranks", []), ("ranks", None),
])
def test_identity_rejects_malformed_top_level(field, value):
    payload = identity()
    payload[field] = value
    with pytest.raises(ValueError):
        probe.validate_identity(payload)


@pytest.mark.parametrize("field,value", [
    ("rank", 0), ("local_rank", 0), ("device_index", 0),
    ("gpu_uuid", "GPU-test-0"), ("gpu_uuid", ""),
    ("name", "NVIDIA H100"), ("vram_bytes", 79 * 1024**3),
    ("compute_major", 8), ("bf16", False),
])
def test_identity_rejects_duplicate_device_or_insufficient_hardware(field, value):
    payload = identity()
    payload["ranks"][1][field] = value
    with pytest.raises(ValueError):
        probe.validate_identity(payload)


def test_identity_rejects_missing_rank():
    payload = identity()
    payload["ranks"].pop()
    with pytest.raises(ValueError):
        probe.validate_identity(payload)


@pytest.mark.parametrize("value", ["", "2030-01-01", "2030-01-01T12:00:00", "nonsense"])
def test_deadline_requires_timezone(value):
    with pytest.raises(ValueError):
        probe.parse_deadline(value)


def test_deadline_parses_utc_without_losing_timezone():
    value = probe.parse_deadline("2030-01-01T12:00:00Z")
    assert value == datetime(2030, 1, 1, 12, tzinfo=timezone.utc)
    assert value.utcoffset() == timedelta(0)


def test_load_json_rejects_invalid_and_oversized_receipts(tmp_path):
    path = tmp_path / "receipt.json"
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError):
        probe.load_json(path)
    path.write_text(json.dumps({"padding": "x" * 100}), encoding="utf-8")
    with pytest.raises(ValueError):
        probe.load_json(path, max_bytes=20)


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
def test_load_json_rejects_nonfinite_json_constants(tmp_path, value):
    path = tmp_path / "receipt.json"
    path.write_text('{"value":' + value + '}', encoding="utf-8")
    with pytest.raises(ValueError):
        probe.load_json(path)


def test_load_json_reads_plain_receipt(tmp_path):
    path = tmp_path / "receipt.json"
    payload = {"status": "local-only", "ranks": [0, 1]}
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert probe.load_json(path) == payload


def test_exclusive_output_never_clobbers_existing_directory(tmp_path):
    output = tmp_path / "new-run"
    probe.exclusive_output(output)
    sentinel = output / "keep.txt"
    sentinel.write_text("preserved", encoding="utf-8")
    with pytest.raises((FileExistsError, ValueError)):
        probe.exclusive_output(output)
    assert sentinel.read_text(encoding="utf-8") == "preserved"


def test_exclusive_output_rejects_existing_file(tmp_path):
    output = tmp_path / "occupied"
    output.write_text("preserved", encoding="utf-8")
    with pytest.raises((FileExistsError, ValueError)):
        probe.exclusive_output(output)
    assert output.read_text(encoding="utf-8") == "preserved"


@pytest.mark.parametrize("value", [
    "../outside.py", "nested/../../outside.py", "/outside.py",
    "C:/outside.py", r"C:\outside.py", r"..\outside.py",
    "https://example.com/source.py", "", "./../outside.py",
])
def test_source_paths_reject_escape_and_remote_references(value):
    with pytest.raises(ValueError):
        probe.validate_relative_source(value)


def test_source_path_accepts_repository_relative_source():
    probe.validate_relative_source("ilaria/forge/train_ilaria.py")


def test_checkpoint_compare_identical_nested_state():
    state = {"model": {"weight": [1.0, 2.0]}, "step": 6,
             "signature": {"world_size": 8},
             "rank_rng": [{"rank": rank, "state": [rank, 42]} for rank in range(8)]}
    result = probe.compare_checkpoints(state, copy.deepcopy(state))
    assert result["bitwise_equal"] is True
    assert result["numerically_close"] is True
    assert result["differences"] == []


@pytest.mark.parametrize("state", [
    {"model": {"weight": [float("nan")]}},
    {"model": {"weight": [float("inf")]}},
])
def test_checkpoint_compare_rejects_nonfinite_model_state(state):
    with pytest.raises(ValueError):
        probe.compare_checkpoints(state, copy.deepcopy(state))


@pytest.mark.parametrize("key,left,right", [
    ("step", 6, 5), ("tokens_seen", 6144, 5120),
    ("signature", {"world_size": 8}, {"world_size": 7}),
    ("rank_rng", [{"state": 1}], [{"state": 2}]),
])
def test_checkpoint_compare_rejects_counter_signature_and_rng_drift(key, left, right):
    result = probe.compare_checkpoints({key: left}, {key: right})
    assert result["bitwise_equal"] is False
    assert result["numerically_close"] is False
    assert result["differences"]


def test_checkpoint_compare_rejects_missing_nested_state():
    result = probe.compare_checkpoints({"model": {"weight": [1.0]}}, {"model": {}})
    assert result["bitwise_equal"] is False
    assert result["numerically_close"] is False
    assert result["differences"]


def test_checkpoint_tolerance_does_not_claim_bitwise_equality():
    left = {"model": {"weight": [1.0]}}
    right = {"model": {"weight": [1.0 + 1e-9]}}
    result = probe.compare_checkpoints(left, right)
    assert result["bitwise_equal"] is False
    assert result["numerically_close"] is True
    assert result["differences"]


def test_checkpoint_large_model_drift_fails_numerical_comparison():
    result = probe.compare_checkpoints({"model": {"weight": [1.0]}},
                                       {"model": {"weight": [2.0]}})
    assert result["bitwise_equal"] is False
    assert result["numerically_close"] is False


def checkpoint(step=6):
    return {"schema_version": 3, "signature": {"device": "cuda", "world_size": 8},
            "rank_rng": [{"rank": rank} for rank in range(8)],
            "step": step, "tokens_seen": 1024 * step}


def test_counters_require_locked_total_tokens():
    probe.validate_counters(checkpoint(), 6)
    probe.validate_counters(checkpoint(3), 3)


@pytest.mark.parametrize("field,value", [
    ("step", 5), ("step", True), ("tokens_seen", 6143),
    ("tokens_seen", True), ("rank_rng", []), ("rank_rng", [None] * 7),
    ("signature", {"device": "cpu", "world_size": 8}),
    ("signature", {"device": "cuda", "world_size": 1}),
])
def test_counters_reject_incomplete_or_drifting_resume_state(field, value):
    state = checkpoint()
    state[field] = value
    with pytest.raises(ValueError):
        probe.validate_counters(state, 6)


class FakeClock:
    def __init__(self):
        self.start = datetime(2030, 1, 1, tzinfo=timezone.utc)
        self.elapsed = 0.0

    def now(self):
        return self.start + timedelta(seconds=self.elapsed)

    def monotonic(self):
        return self.elapsed

    def sleep(self, duration):
        self.elapsed += duration


def fake_supervisor(monkeypatch, durations, max_wall=5.0, *, ignore_term=False, orphan=False):
    """Budget-only scope double; actual containment is proved by native Linux tests."""
    clock = FakeClock()
    spawned, signals = [], []
    duration_iterator = iter(durations)
    holder = {}
    def scope_runner(request=None, **kwargs):
        spawned.append((request["argv"], request))
        allowance = request["phase_end_monotonic"] - clock.elapsed
        duration = next(duration_iterator)
        timed_out = duration > allowance
        clock.elapsed += min(duration, allowance)
        if timed_out:
            signals.append(signal.SIGTERM)
            if ignore_term: signals.append(signal.SIGKILL)
        if orphan: clock.elapsed += request["teardown_seconds"]
        helper = holder["supervisor"].containment
        return {"format": "imc-supervised-scope-v1", "capability_version": helper.VERSION, "source_sha256": helper.source_pins(),
                "kernel_subreaper_verified": True, "pidfd_signals_verified": True,
                "pid": 10000000 + len(spawned), "returncode": -9 if timed_out else 0,
                "timed_out": timed_out, "cleanup_verified": not orphan,
                "no_children_verified": not orphan, "scope_worker_exited": True,
                "owned_processes": [{"exit_verified": not orphan}]}
    limits = probe.Limits(clock.start + timedelta(seconds=100), max_wall, 20.0, 1.0)
    supervisor = probe.Supervisor(limits, now_utc=clock.now, monotonic=clock.monotonic, scope_runner=scope_runner)
    holder["supervisor"] = supervisor
    return supervisor, clock, spawned, signals


def test_expired_deadline_prevents_spawn(tmp_path):
    now = datetime(2030, 1, 1, tzinfo=timezone.utc)
    spawned = []
    limits = probe.Limits(now - timedelta(seconds=1), 5.0, 4.0, 1.0)

    def never_spawn(*args, **kwargs):
        spawned.append(args)
        raise AssertionError("expired execution must never spawn")

    with pytest.raises(ValueError):
        supervisor = probe.Supervisor(limits, now_utc=lambda: now, monotonic=lambda: 0.0,
                                      scope_runner=never_spawn)
        supervisor.run(["fake-worker"], tmp_path, tmp_path / "expired.log")
    assert spawned == []


def test_all_phases_share_one_cumulative_wall_budget(monkeypatch, tmp_path):
    supervisor, clock, spawned, _ = fake_supervisor(monkeypatch, [2.0, 10.0])
    first = supervisor.run(["fake-first"], tmp_path, tmp_path / "first.log")
    second = supervisor.run(["fake-second"], tmp_path, tmp_path / "second.log")
    assert first["returncode"] == 0
    assert first["timed_out"] is False
    assert second["timed_out"] is True
    assert second["cleanup_verified"] is True
    assert len(spawned) == 2
    assert clock.elapsed <= 5.0


def test_timeout_escalates_and_verifies_group_cleanup(monkeypatch, tmp_path):
    supervisor, clock, spawned, signals = fake_supervisor(
        monkeypatch, [10.0], ignore_term=True)
    result = supervisor.run(["fake-worker"], tmp_path, tmp_path / "timeout.log")
    assert result["timed_out"] is True
    assert result["cleanup_verified"] is True
    assert signal.SIGTERM in signals
    assert signal.SIGKILL in signals
    assert len(spawned) == 1
    assert clock.elapsed <= 5.0


def test_reaped_parent_does_not_prove_descendant_cleanup(monkeypatch, tmp_path):
    supervisor, clock, _, signals = fake_supervisor(
        monkeypatch, [10.0], ignore_term=True, orphan=True)
    result = supervisor.run(["fake-worker"], tmp_path, tmp_path / "orphan.log")
    assert result["timed_out"] is True
    assert result["cleanup_verified"] is False
    assert signal.SIGKILL in signals
    assert clock.elapsed <= 5.0


def stub_canonical_worker(monkeypatch, tmp_path):
    """Observe forwarding without importing Torch or running model code."""
    calls = []
    fake_torch = types.ModuleType("torch")
    fake_torch.__path__ = []
    fake_dist = types.ModuleType("torch.distributed")
    fake_dist.init_process_group = lambda *args, **kwargs: None
    fake_dist.get_backend = lambda: "nccl"
    fake_dist.get_world_size = lambda: 8
    fake_torch.distributed = fake_dist
    fake_trainer = types.ModuleType("train_ilaria")
    fake_trainer.main = lambda: calls.append(list(probe.sys.argv))
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "torch.distributed", fake_dist)
    monkeypatch.setitem(sys.modules, "train_ilaria", fake_trainer)
    monkeypatch.setattr(probe.sys, "platform", "linux")
    monkeypatch.setattr(probe.sys, "path", list(sys.path))
    monkeypatch.setattr(probe.sys, "argv", ["stub-caller"])
    monkeypatch.setattr(probe, "verify_sources", lambda *args: {})
    pins = tmp_path / "stub-pins.json"
    pins.write_text("{}", encoding="utf-8")
    base = ["--trainer-worker", "--output", str(tmp_path),
            "--forge-root", str(tmp_path), "--source-pins", str(pins)]
    return calls, base


@pytest.mark.parametrize("precision", ["fp32", "bf16"])
def test_worker_forwards_requested_precision_to_canonical_main(monkeypatch, tmp_path, precision):
    calls, base = stub_canonical_worker(monkeypatch, tmp_path)
    assert probe.main(base + ["--precision", precision, "--steps", "6", "--out", "new-run"]) == 0
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.count("--precision") == 1
    assert forwarded[forwarded.index("--precision") + 1] == precision
    assert forwarded[forwarded.index("--steps") + 1] == "6"
    assert forwarded[forwarded.index("--out") + 1] == "new-run"
    assert "--trainer-worker" not in forwarded


@pytest.mark.parametrize("timeout", ["0", "-1", "nan", "inf", "-inf"])
def test_worker_rejects_invalid_collective_timeout_before_canonical_main(monkeypatch, tmp_path, timeout):
    calls, base = stub_canonical_worker(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match="collective_timeout"):
        probe.main(base + ["--collective-timeout-seconds=" + timeout])
    assert calls == []


def checkpoint_result(phase="final"):
    step = 3 if phase == "pause" else 6
    result = {"format": "imc-nccl-checkpoint-proof-v1", "phase": phase, "status": "PASS",
              "step": step, "tokens_seen": step * 1024, "rank_rng_count": 8,
              "source_binding_verified": True, "inspection_device": "cpu"}
    if phase == "final":
        result["comparison"] = {"bitwise_equal": True, "numerically_close": True, "differences": []}
    return result


def test_checkpoint_cpu_phase_is_supervised_and_reads_only_small_result(tmp_path):
    calls = []
    class StubSupervisor:
        def run(self, argv, cwd, log_path):
            calls.append(argv)
            (tmp_path / "checkpoint-final.json").write_text(json.dumps(checkpoint_result()), encoding="utf-8")
            return {"status": "PASS", "cleanup_verified": True, "timed_out": False}
        def remaining(self):
            return 1.0
    observed, result = probe.supervised_checkpoint(StubSupervisor(), tmp_path, tmp_path, "public-pins.json", "final")
    assert observed["name"] == "checkpoint-final"
    assert result["comparison"]["bitwise_equal"] is True
    assert len(calls) == 1 and "--checkpoint-worker" in calls[0]


@pytest.mark.parametrize("status", ["FAIL", "TIMEOUT"])
def test_checkpoint_cpu_failure_never_reads_or_accepts_result(monkeypatch, tmp_path, status):
    class StubSupervisor:
        def run(self, *args):
            return {"status": status, "cleanup_verified": False, "timed_out": status == "TIMEOUT"}
    monkeypatch.setattr(probe, "read_checkpoint_result", lambda *args: pytest.fail("failed worker result must not be read"))
    with pytest.raises(probe.CheckpointPhaseError, match="CPU phase") as raised:
        probe.supervised_checkpoint(StubSupervisor(), tmp_path, tmp_path, "public-pins.json", "final")
    assert raised.value.phase_observation["cleanup_verified"] is False
    assert raised.value.phase_observation["name"] == "checkpoint-final"


@pytest.mark.parametrize("field,value", [("status", "FAIL"), ("step", 3), ("tokens_seen", 0),
    ("rank_rng_count", 7), ("source_binding_verified", False), ("inspection_device", "cuda"),
    ("comparison", {"bitwise_equal": True, "numerically_close": True, "differences": ["model.drift"]}),
    ("comparison", {"bitwise_equal": "yes", "numerically_close": True, "differences": []})])
def test_checkpoint_result_rejects_failed_or_malformed_proof(tmp_path, field, value):
    result = checkpoint_result()
    result[field] = value
    (tmp_path / "checkpoint-final.json").write_text(json.dumps(result), encoding="utf-8")
    with pytest.raises(ValueError):
        probe.read_checkpoint_result(tmp_path, "final")


def test_checkpoint_result_size_and_nonfinite_json_are_capped(tmp_path):
    result = tmp_path / "checkpoint-final.json"
    result.write_text(" " * 65537, encoding="utf-8")
    with pytest.raises(ValueError):
        probe.read_checkpoint_result(tmp_path, "final")
    result.write_text('{"overflow":1e999}', encoding="utf-8")
    with pytest.raises(ValueError, match="nonfinite"):
        probe.read_checkpoint_result(tmp_path, "final")


def test_checkpoint_worker_inspects_only_new_cpu_fixture(monkeypatch, tmp_path):
    import torch
    monkeypatch.setattr(probe, "verify_sources", lambda *args: {})
    monkeypatch.setattr(torch.cuda, "_lazy_init", lambda: pytest.fail("CPU checkpoint worker must not initialize CUDA"))
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "stub-test-preserved")
    resumed = tmp_path / "resumed"
    resumed.mkdir()
    pins = {"files": {"train_ilaria.py": "a" * 64, "imc_model.py": "b" * 64}}
    ck = {"step": 3, "tokens_seen": 3072, "rank_rng": [{} for _ in range(8)],
          "signature": {"device": "cuda", "world_size": 8, "trainer_sha256": "a" * 64, "imc_model_sha256": "b" * 64},
          "model": {"synthetic_weight": torch.tensor([1.0])}}
    torch.save(ck, resumed / "checkpoint.pt")
    probe.checkpoint_worker(tmp_path, tmp_path, pins, "pause")
    assert probe.read_checkpoint_result(tmp_path, "pause")["inspection_device"] == "cpu"
    with pytest.raises(ValueError, match="already exists"):
        probe.checkpoint_worker(tmp_path, tmp_path, pins, "pause")
