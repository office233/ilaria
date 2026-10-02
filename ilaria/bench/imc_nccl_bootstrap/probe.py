"""Bounded, opt-in synthetic IMC/NCCL stage probe; no cloud authority."""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone

FORMAT = "imc-nccl-bootstrap-v1"
WORLD = 8
TOKENS_PER_STEP = WORLD * 16 * 4 * 2
MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024


def parse_deadline(value):
    if not isinstance(value, str):
        raise ValueError("deadline must be a timezone-aware ISO string")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid absolute deadline") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("deadline requires a timezone")
    return result.astimezone(timezone.utc)


def _finite(value, name, positive=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError(f"invalid {name}")
    return value


def load_json(path, max_bytes=1024 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > max_bytes:
        raise ValueError("JSON input missing, linked, or exceeds byte cap")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def constant(value):
        raise ValueError("nonfinite JSON number: " + value)
    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError("nonfinite JSON number: " + value)
        return result
    with path.open(encoding="utf-8") as handle:
        return json.load(handle, parse_constant=constant, parse_float=finite_float, object_pairs_hook=pairs)


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + ".pending")
    with temp.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def exclusive_output(path):
    path = Path(path).absolute()
    if path.exists() or path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError("output must be a new exclusive directory without symlink parents")
    path.mkdir(parents=False, exist_ok=False)
    return path


def validate_relative_source(value):
    if (not isinstance(value, str) or not value or "\\" in value or ":" in value
            or PurePosixPath(value).is_absolute() or any(part in ("", ".", "..") for part in value.split("/"))
            or not value.endswith(".py")):
        raise ValueError("untrusted relative Python source path")
    return value


def source_closure(root):
    root = Path(root).resolve(strict=True)
    pending = ["train_ilaria.py", "imc_model.py", "training_state.py"]
    found = set()
    while pending:
        name = pending.pop()
        if name in found:
            continue
        validate_relative_source(name)
        path = root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            raise ValueError("missing or unsafe canonical source: " + name)
        found.add(name)
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=name)
        for node in ast.walk(tree):
            modules = ([alias.name for alias in node.names] if isinstance(node, ast.Import)
                       else [node.module] if isinstance(node, ast.ImportFrom) and node.module else [])
            for module in modules:
                local = module.split(".")[0] + ".py"
                if (root / local).is_file() and local not in found:
                    pending.append(local)
    return sorted(found)


def verify_sources(root, pins):
    if not isinstance(pins, dict) or set(pins) != {"format", "files"} or pins["format"] != "imc-probe-source-pins-v1":
        raise ValueError("invalid source pins manifest")
    files = pins["files"]
    if not isinstance(files, dict) or set(files) != set(source_closure(root)):
        raise ValueError("pins must cover exactly the canonical local Python import closure")
    for name, expected in files.items():
        validate_relative_source(name)
        if not isinstance(expected, str) or len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
            raise ValueError("invalid lowercase source SHA256")
        actual = hashlib.sha256((Path(root) / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError("canonical source pin drift: " + name)
    return dict(files)


@dataclass(frozen=True)
class Limits:
    deadline: datetime
    max_wall_seconds: float
    phase_timeout_seconds: float
    teardown_seconds: float
    threads: int = 1

    def __post_init__(self):
        if not isinstance(self.deadline, datetime) or self.deadline.tzinfo is None or self.deadline.utcoffset() is None:
            raise ValueError("deadline requires an explicit timezone")
        for name in ("max_wall_seconds", "phase_timeout_seconds", "teardown_seconds"):
            _finite(getattr(self, name), name, positive=True)
        if type(self.threads) is not int or not 1 <= self.threads <= 64:
            raise ValueError("threads must be 1..64")


def containment_module():
    name = "imc_nccl_bootstrap_containment"
    path = Path(__file__).with_name("containment.py")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("strict containment helper missing")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Supervisor:
    def __init__(self, limits, now_utc=None, monotonic=time.monotonic, *,
                 containment_binding=None, scope_runner=None):
        self.limits = limits
        self.now_utc = now_utc or (lambda: datetime.now(timezone.utc))
        self.monotonic = monotonic
        self.started = monotonic()
        self.containment = containment_module()
        self.binding = self.containment.validate_binding(containment_binding)
        self.scope_runner = scope_runner or self.containment.run_scope

    def remaining(self):
        return min(self.limits.max_wall_seconds - (self.monotonic() - self.started),
                   (self.limits.deadline - self.now_utc()).total_seconds())

    def strict_capability(self):
        result = self.scope_runner()
        if (result.get("format") != self.containment.FORMAT
                or result.get("capability_version") != self.containment.VERSION
                or result.get("source_sha256") != self.containment.source_pins()
                or result.get("kernel_subreaper_verified") is not True
                or result.get("pidfd_signals_verified") is not True
                or result.get("readiness_verified") is not True
                or result.get("scope_worker_exited") is not True):
            raise ValueError("strict kernel containment capability unverified")
        return result

    def run(self, argv, cwd, log_path):
        if (not isinstance(argv, list) or not argv or len(argv) > 256
                or any(not isinstance(a, str) or not a or any(c in a for c in ("\0", "\n", "\r"))
                       or len(a.encode()) > 8192 for a in argv)):
            raise ValueError("argv must be bounded explicit strings")
        allowance = min(self.remaining() - self.limits.teardown_seconds, self.limits.phase_timeout_seconds)
        if allowance <= 0:
            raise ValueError("deadline/wall budget expired before spawn including cleanup reserve")
        start = self.monotonic()
        observed = self.scope_runner({
            "command": "run", "argv": list(argv), "cwd": str(Path(cwd).resolve()),
            "deadline_unix": self.limits.deadline.timestamp(),
            "hard_end_monotonic": self.started + self.limits.max_wall_seconds,
            "phase_end_monotonic": start + allowance,
            "teardown_seconds": self.limits.teardown_seconds, "threads": self.limits.threads,
            "binding": self.binding, "log_limit": self.containment.LOG_LIMIT}, log_path=log_path)
        elapsed = self.monotonic() - start
        strict = (observed.get("format") == "imc-supervised-scope-v1"
                  and observed.get("capability_version") == self.containment.VERSION
                  and observed.get("source_sha256") == self.containment.source_pins()
                  and observed.get("kernel_subreaper_verified") is True
                  and observed.get("pidfd_signals_verified") is True
                  and observed.get("no_children_verified") is True
                  and observed.get("scope_worker_exited") is True
                  and observed.get("cleanup_verified") is True
                  and isinstance(observed.get("owned_processes"), list)
                  and all(p.get("exit_verified") is True for p in observed["owned_processes"]))
        observed.update(elapsed_seconds=elapsed,
                        status="PASS" if strict and observed.get("returncode") == 0
                        and not observed.get("timed_out") and not observed.get("stop_reason")
                        and not observed.get("error") and self.remaining() >= 0 else "FAIL")
        return observed


def validate_identity(payload):
    if not isinstance(payload, dict) or payload.get("format") != "imc-nccl-identity-v1" or type(payload.get("world_size")) is not int or payload.get("world_size") != WORLD or payload.get("backend") != "nccl":
        raise ValueError("identity must prove NCCL world of eight")
    ranks = payload.get("ranks")
    if not isinstance(ranks, list) or len(ranks) != WORLD:
        raise ValueError("missing rank identity")
    numbers, uuids = set(), set()
    for entry in ranks:
        if not isinstance(entry, dict):
            raise ValueError("malformed rank identity")
        rank = entry.get("rank")
        if type(rank) is not int or not 0 <= rank < WORLD or rank in numbers:
            raise ValueError("duplicate or invalid rank")
        if type(entry.get("local_rank")) is not int or type(entry.get("device_index")) is not int or entry["local_rank"] != rank or entry["device_index"] != rank:
            raise ValueError("rank/device placement mismatch")
        uuid = entry.get("gpu_uuid")
        if not isinstance(uuid, str) or not uuid or uuid in uuids:
            raise ValueError("missing or duplicate GPU UUID")
        if (not isinstance(entry.get("name"), str) or "h200" not in entry["name"].lower()
                or type(entry.get("vram_bytes")) is not int or entry["vram_bytes"] < 80 * 1024**3
                or type(entry.get("compute_major")) is not int or entry["compute_major"] < 9
                or entry.get("bf16") is not True):
            raise ValueError("H200 hardware requirement mismatch")
        numbers.add(rank)
        uuids.add(uuid)
    if type(payload.get("all_reduce_sum")) is not int or payload.get("all_reduce_sum") != sum(range(WORLD)):
        raise ValueError("NCCL all-reduce proof mismatch")
    return payload


def validate_counters(checkpoint, expected_step):
    if not isinstance(checkpoint, dict) or type(expected_step) is not int or expected_step < 0:
        raise ValueError("invalid checkpoint")
    signature = checkpoint.get("signature", {})
    if not isinstance(signature, dict) or signature.get("device") != "cuda" or type(signature.get("world_size")) is not int or signature["world_size"] != WORLD:
        raise ValueError("checkpoint must bind CUDA/eight ranks")
    if type(checkpoint.get("step")) is not int or checkpoint["step"] != expected_step or type(checkpoint.get("tokens_seen")) is not int or checkpoint["tokens_seen"] != TOKENS_PER_STEP * expected_step:
        raise ValueError("checkpoint counter mismatch")
    if not isinstance(checkpoint.get("rank_rng"), list) or len(checkpoint["rank_rng"]) != WORLD:
        raise ValueError("checkpoint lacks eight rank RNG states")
    return checkpoint


def compare_checkpoints(left, right):
    import torch
    differences = []
    numerical = True
    def compare(a, b, path):
        nonlocal numerical
        equal = True
        if isinstance(a, torch.Tensor) and isinstance(b, torch.Tensor):
            if not torch.isfinite(a).all() or not torch.isfinite(b).all():
                raise ValueError("nonfinite checkpoint tensor: " + path)
            equal = a.dtype == b.dtype and a.shape == b.shape and torch.equal(a, b)
            close = a.dtype == b.dtype and a.shape == b.shape and (torch.allclose(a, b, rtol=1e-5, atol=1e-7) if a.is_floating_point() else torch.equal(a, b))
            numerical = numerical and bool(close)
        elif isinstance(a, dict) and isinstance(b, dict):
            if a.keys() != b.keys():
                numerical = False
                equal = False
            else:
                for key in a:
                    compare(a[key], b[key], path + "." + str(key))
                return
        elif isinstance(a, (list, tuple)) and type(a) is type(b) and len(a) == len(b):
            for index, (x, y) in enumerate(zip(a, b)):
                compare(x, y, path + f"[{index}]")
            return
        else:
            if isinstance(a, float) and not math.isfinite(a) or isinstance(b, float) and not math.isfinite(b):
                raise ValueError("nonfinite checkpoint scalar: " + path)
            equal = type(a) is type(b) and a == b
            if not equal and not path.endswith(".best_export_sha256"):
                numerical = numerical and isinstance(a, float) and isinstance(b, float) and math.isclose(a, b, rel_tol=1e-5, abs_tol=1e-7)
        if not equal and len(differences) < 64:
            differences.append(path)
    compare(left, right, "checkpoint")
    return {"bitwise_equal": not differences, "numerically_close": numerical, "differences": differences}


def identity_worker(output, collective_timeout=30):
    import torch
    import torch.distributed as dist
    from datetime import timedelta
    rank, local, world = (int(os.environ[name]) for name in ("RANK", "LOCAL_RANK", "WORLD_SIZE"))
    if world != WORLD or local != rank or torch.cuda.device_count() != WORLD:
        raise ValueError("worker placement/visible CUDA inventory differs from eight")
    torch.cuda.set_device(local)
    dist.init_process_group("nccl", timeout=timedelta(seconds=collective_timeout))
    try:
        properties = torch.cuda.get_device_properties(local)
        uuid = getattr(properties, "uuid", None)
        if uuid is None:
            raise ValueError("Torch does not expose a stable GPU UUID; hardware proof unavailable")
        entry = {"rank": rank, "local_rank": local, "device_index": torch.cuda.current_device(),
                 "gpu_uuid": str(uuid), "name": properties.name, "vram_bytes": properties.total_memory,
                 "compute_major": properties.major, "bf16": bool(torch.cuda.is_bf16_supported())}
        ranks = [None] * WORLD
        dist.all_gather_object(ranks, entry)
        value = torch.tensor(rank, device=f"cuda:{local}", dtype=torch.int64)
        dist.all_reduce(value)
        torch.cuda.synchronize(local)
        payload = {"format": "imc-nccl-identity-v1", "world_size": dist.get_world_size(),
                   "backend": str(dist.get_backend()), "ranks": ranks, "all_reduce_sum": int(value.item()),
                   "torch_version": str(torch.__version__), "cuda_version": str(torch.version.cuda)}
        validate_identity(payload)
        if rank == 0:
            atomic_json(Path(output) / "identity.json", payload)
        dist.barrier()
    finally:
        dist.destroy_process_group()


def make_fixture(output, forge_root):
    import numpy as np
    sys.path.insert(0, str(forge_root))
    from data_contract import TOKEN_STREAM_FORMAT
    tokenizer = output / "tokenizer.json"
    tokenizer.write_text('{"fixture":"synthetic-stage-only"}\n', encoding="utf-8")
    for name, seed in (("train", 0), ("validation", 1)):
        tokens = np.tile(np.arange(4, 36, dtype="<u2"), 400) ^ np.random.default_rng(seed).integers(0, 2, 12800, dtype="<u2")
        binary = output / (name + ".bin")
        tokens.tofile(binary)
        atomic_json(output / (name + ".json"), {"format": TOKEN_STREAM_FORMAT, "dtype": "uint16", "vocab_size": 40,
                    "eos_id": 3, "protocol_start_id": 36, "tokens": len(tokens), "documents": 0,
                    "tokenizer": tokenizer.name, "tokenizer_sha256": hashlib.sha256(tokenizer.read_bytes()).hexdigest(),
                    "tokenizer_format": "ilarialex-v1", "stream_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "byte_level": True})


def _owned_checkpoint(output, name):
    if name not in ("full", "resumed") or Path(output).is_symlink():
        raise ValueError("untrusted generated checkpoint location")
    root = Path(output).resolve(strict=True)
    path = root / name / "checkpoint.pt"
    if (path.is_symlink() or path.parent.is_symlink() or any(parent.is_symlink() for parent in Path(output).absolute().parents)
            or not path.resolve(strict=True).is_relative_to(root) or path.stat().st_size > MAX_CHECKPOINT_BYTES):
        raise ValueError("unsafe or oversized generated checkpoint")
    return path


def checkpoint_worker(output, forge, pins, phase):
    """CPU-only read of this probe's own generated checkpoints, never restore."""
    if phase not in ("pause", "final"):
        raise ValueError("invalid checkpoint phase")
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    verify_sources(forge, pins)
    import torch
    step = 3 if phase == "pause" else 6
    names = ("resumed",) if phase == "pause" else ("full", "resumed")
    checkpoints = []
    for name in names:
        ck = validate_counters(torch.load(_owned_checkpoint(output, name), map_location="cpu", weights_only=True), step)
        if (ck["signature"].get("trainer_sha256") != pins["files"]["train_ilaria.py"]
                or ck["signature"].get("imc_model_sha256") != pins["files"]["imc_model.py"]):
            raise ValueError("executed checkpoint source identity differs")
        def finite_tensors(value):
            if isinstance(value, torch.Tensor):
                if value.device.type != "cpu" or not torch.isfinite(value).all():
                    raise ValueError("nonfinite or non-CPU generated checkpoint tensor")
            elif isinstance(value, dict):
                for nested in value.values():
                    finite_tensors(nested)
            elif isinstance(value, (list, tuple)):
                for nested in value:
                    finite_tensors(nested)
        finite_tensors(ck)
        checkpoints.append(ck)
    result = {"format": "imc-nccl-checkpoint-proof-v1", "phase": phase, "status": "PASS",
              "step": step, "tokens_seen": step * TOKENS_PER_STEP, "rank_rng_count": WORLD,
              "source_binding_verified": True, "inspection_device": "cpu"}
    if phase == "final":
        result["comparison"] = compare_checkpoints(*checkpoints)
    verify_sources(forge, pins)
    result_path = Path(output) / ("checkpoint-" + phase + ".json")
    if result_path.exists():
        raise ValueError("checkpoint result already exists")
    atomic_json(result_path, result)


def read_checkpoint_result(output, phase):
    if phase not in ("pause", "final"):
        raise ValueError("invalid checkpoint phase")
    result = load_json(Path(output) / ("checkpoint-" + phase + ".json"), max_bytes=65536)
    step = 3 if phase == "pause" else 6
    if (not isinstance(result, dict) or result.get("format") != "imc-nccl-checkpoint-proof-v1"
            or result.get("phase") != phase or result.get("status") != "PASS"
            or result.get("source_binding_verified") is not True or result.get("inspection_device") != "cpu"
            or type(result.get("step")) is not int or result["step"] != step
            or type(result.get("tokens_seen")) is not int or result["tokens_seen"] != TOKENS_PER_STEP * step
            or type(result.get("rank_rng_count")) is not int or result["rank_rng_count"] != WORLD):
        raise ValueError("invalid bounded checkpoint result")
    if phase == "final":
        comparison = result.get("comparison")
        if (not isinstance(comparison, dict) or type(comparison.get("bitwise_equal")) is not bool
                or type(comparison.get("numerically_close")) is not bool
                or not isinstance(comparison.get("differences"), list) or len(comparison["differences"]) > 64
                or any(not isinstance(item, str) for item in comparison["differences"])
                or comparison["bitwise_equal"] and (not comparison["numerically_close"] or comparison["differences"])):
            raise ValueError("malformed checkpoint comparison receipt")
    return result


class CheckpointPhaseError(ValueError):
    def __init__(self, message, observation):
        super().__init__(message)
        self.phase_observation = observation


def supervised_checkpoint(supervisor, output, forge, pins_path, phase):
    command = [sys.executable, str(Path(__file__).resolve()), "--checkpoint-worker", "--checkpoint-phase", phase,
               "--output", str(output), "--forge-root", str(forge), "--source-pins", str(pins_path)]
    observed = supervisor.run(command, forge, Path(output) / ("checkpoint-" + phase + ".log"))
    observed["name"] = "checkpoint-" + phase
    if observed["status"] != "PASS":
        raise CheckpointPhaseError("checkpoint CPU phase timed out, failed or cleanup unverified: " + phase, observed)
    if supervisor.remaining() <= 0:
        raise CheckpointPhaseError("deadline exhausted before reading checkpoint result", observed)
    try:
        result = read_checkpoint_result(output, phase)
    except (OSError, ValueError) as exc:
        raise CheckpointPhaseError("checkpoint CPU result rejected: " + str(exc), observed) from exc
    return observed, result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--identity-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--trainer-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--checkpoint-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--checkpoint-phase", choices=("pause", "final"), help=argparse.SUPPRESS)
    parser.add_argument("--collective-timeout-seconds", type=float, default=20, help=argparse.SUPPRESS)
    parser.add_argument("--local-rank", "--local_rank", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--output", required=True)
    parser.add_argument("--forge-root")
    parser.add_argument("--source-pins")
    parser.add_argument("--absolute-deadline")
    parser.add_argument("--max-wall-seconds", type=float, default=180)
    parser.add_argument("--phase-timeout-seconds", type=float, default=45)
    parser.add_argument("--teardown-seconds", type=float, default=5)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--precision", choices=("fp32", "bf16"), default="fp32")
    parser.add_argument("--execute", action="store_true")
    args, trainer_args = parser.parse_known_args(argv)
    _finite(args.collective_timeout_seconds, "collective_timeout", positive=True)
    if sum((args.trainer_worker, args.identity_worker, args.checkpoint_worker)) > 1:
        raise ValueError("worker modes are mutually exclusive")
    if trainer_args and not args.trainer_worker:
        parser.error("unknown probe arguments")
    if args.checkpoint_worker:
        if not args.forge_root or not args.source_pins or not args.checkpoint_phase:
            raise ValueError("checkpoint worker requires pinned sources and explicit phase")
        checkpoint_worker(args.output, args.forge_root, load_json(args.source_pins), args.checkpoint_phase)
        return 0
    if args.trainer_worker:
        if not sys.platform.startswith("linux") or not args.forge_root or not args.source_pins:
            raise ValueError("trainer worker requires Linux and pinned canonical sources")
        verify_sources(args.forge_root, load_json(args.source_pins))
        import torch.distributed as dist
        from datetime import timedelta
        original_init = dist.init_process_group
        def bounded_init(*positional, **keywords):
            keywords["timeout"] = timedelta(seconds=args.collective_timeout_seconds)
            result = original_init(*positional, **keywords)
            if dist.get_backend() != "nccl" or dist.get_world_size() != WORLD:
                raise ValueError("canonical trainer did not initialize NCCL/eight ranks")
            return result
        dist.init_process_group = bounded_init
        sys.path.insert(0, str(Path(args.forge_root).resolve()))
        from train_ilaria import main as canonical_main
        sys.argv = [str(Path(args.forge_root) / "train_ilaria.py"), *trainer_args, "--precision", args.precision]
        canonical_main()
        verify_sources(args.forge_root, load_json(args.source_pins))
        return 0
    if args.identity_worker:
        if not sys.platform.startswith("linux"):
            raise ValueError("identity worker is Linux only")
        _finite(args.collective_timeout_seconds, "collective_timeout", positive=True)
        identity_worker(args.output, args.collective_timeout_seconds)
        return 0
    if not args.forge_root or not args.source_pins or not args.absolute_deadline:
        parser.error("--forge-root, --source-pins and --absolute-deadline are required")
    forge = Path(args.forge_root).resolve(strict=True)
    pins = load_json(args.source_pins)
    verify_sources(forge, pins)
    limits = Limits(parse_deadline(args.absolute_deadline), args.max_wall_seconds,
                    args.phase_timeout_seconds, args.teardown_seconds, args.threads)
    supervisor = Supervisor(limits)
    if supervisor.remaining() <= limits.teardown_seconds:
        raise ValueError("fresh deadline and cleanup reserve are required")
    if not args.execute:
        print(json.dumps({"format": FORMAT, "status": "DRY_RUN_ONLY", "world_size": WORLD,
                          "source_pins": pins, "output": args.output, "gpu_proof": False}, allow_nan=False))
        return 0
    if not sys.platform.startswith("linux"):
        raise ValueError("execution requires Linux subreaper/pidfd containment")
    output = exclusive_output(args.output)
    receipt = {"format": FORMAT, "status": "INCOMPLETE", "gpu_proof": False, "world_size": WORLD,
               "source_pins": pins, "phases": [], "classification": "SYNTHETIC_IMC_STAGE_ONLY"}
    atomic_json(output / "receipt.json", receipt)
    try:
        make_fixture(output, forge)
        launch = [sys.executable, "-m", "torch.distributed.run", "--standalone", "--nproc_per_node=8", "--max_restarts=0"]
        base = [str(Path(__file__).resolve()), "--trainer-worker", "--output", str(output), "--forge-root", str(forge),
                "--source-pins", str(Path(args.source_pins).resolve()), "--collective-timeout-seconds", "20",
                "--data", str(output / "train"), "--val-data", str(output / "validation"),
                "--allow-unmanifested-data", "--ternary", "--embed-dim", "32", "--heads", "4", "--kv-heads", "2",
                "--layers", "2", "--ffn-dim", "48", "--ctx", "16", "--max-seq-len", "16", "--batch", "4",
                "--accum", "2", "--steps", "6", "--warmup", "4", "--lr", "0.003", "--min-lr", "0.0003",
                "--eval-every", "4", "--eval-iters", "2", "--chunked-loss", "--sample-tokens", "0", "--precision", args.precision]
        commands = [("identity", launch + [str(Path(__file__).resolve()), "--identity-worker", "--output", str(output),
                                           "--collective-timeout-seconds", str(min(20, args.phase_timeout_seconds / 2))]),
                    ("full", launch + base + ["--out", str(output / "full")]),
                    ("pause", launch + base + ["--out", str(output / "resumed"), "--stop-after", "3"]),
                    ("resume", launch + base + ["--out", str(output / "resumed"), "--resume", str(output / "resumed" / "checkpoint.pt")])]
        for name, command in commands:
            verify_sources(forge, pins)
            collective_at = command.index("--collective-timeout-seconds") + 1
            command[collective_at] = str(max(0.001, min(20, args.phase_timeout_seconds / 2, supervisor.remaining() - limits.teardown_seconds)))
            phase = supervisor.run(command, forge, output / (name + ".log"))
            phase["name"] = name
            receipt["phases"].append(phase)
            atomic_json(output / "receipt.json", receipt)
            verify_sources(forge, pins)
            if phase["status"] != "PASS":
                raise ValueError("phase failed or cleanup unverified: " + name)
            if name == "identity":
                receipt["hardware"] = validate_identity(load_json(output / "identity.json"))
            elif name == "pause":
                observed, result = supervised_checkpoint(supervisor, output, forge, Path(args.source_pins).resolve(), "pause")
                receipt["phases"].append(observed)
                receipt["pause_checkpoint"] = result
                atomic_json(output / "receipt.json", receipt)
                verify_sources(forge, pins)
        observed, final_result = supervised_checkpoint(supervisor, output, forge, Path(args.source_pins).resolve(), "final")
        receipt["phases"].append(observed)
        comparison = final_result["comparison"]
        receipt["comparison"] = comparison
        receipt["throughput"] = {phase["name"]: {"tokens": 6144 if phase["name"] == "full" else 3072,
                                    "end_to_end_tokens_per_second": (6144 if phase["name"] == "full" else 3072) / phase["elapsed_seconds"]}
                                 for phase in receipt["phases"] if phase["name"] in ("full", "pause", "resume")}
        receipt["status"] = "BITWISE_EXACT_PASS" if comparison["bitwise_equal"] else "NUMERICAL_CONTINUITY_ONLY" if comparison["numerically_close"] else "FAIL"
        receipt["gpu_proof"] = comparison["bitwise_equal"]
        verify_sources(forge, pins)
        if supervisor.remaining() < 0:
            raise ValueError("verification exceeded cumulative wall/deadline budget")
    except Exception as exc:
        receipt["status"] = "FAIL"
        receipt["gpu_proof"] = False
        receipt["error"] = str(exc)
        if isinstance(exc, CheckpointPhaseError):
            receipt["phases"].append(exc.phase_observation)
    finally:
        atomic_json(output / "receipt.json", receipt)
    print(json.dumps(receipt, allow_nan=False))
    return 0 if receipt["status"] == "BITWISE_EXACT_PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
