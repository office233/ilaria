"""Strict world-8 NCCL hardware identity/topology gate.

This is a hardware proof only. It reuses the already reviewed/pinned Linux
subreaper+pidfd supervisor from imc_nccl_bootstrap without modifying it. It
never trains a model, creates cloud resources, accepts Terms, or grants
allocation/promotion authority.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Mapping


FORMAT = "imc-nccl-hardware-gate-v1"
CONTRACT_FORMAT = "imc-nccl-hardware-contract-v1"
IDENTITY_FORMAT = "imc-nccl-hardware-identity-v1"
TOPOLOGY_FORMAT = "imc-nccl-topology-v1"
WORLD = 8
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_TOPOLOGY_BYTES = 256 * 1024
ALLOWED_GPU_FAMILIES = frozenset({"H100", "H200", "B200"})
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_TEXT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$")
_NVLINK = re.compile(r"^NV[1-9][0-9]*$")
_GPU_ROW = re.compile(r"^GPU([0-9]+)$")

SUPERVISOR_SOURCE_PINS = {
    "probe.py": "b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704",
    "containment.py": "2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894",
}


class HardwareGateError(ValueError):
    """Invalid hardware contract/proof."""


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise HardwareGateError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _load_json(path: str | Path, *, max_bytes: int = MAX_JSON_BYTES) -> Any:
    target = Path(path)
    if target.is_symlink() or not target.is_file():
        raise HardwareGateError(f"JSON input missing or symlinked: {target}")
    with target.open("rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise HardwareGateError("JSON input exceeds byte cap")

    def nonfinite(value):
        raise HardwareGateError(f"non-finite JSON number: {value}")

    value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)
    return value


def _canonical_sha256(value: Mapping[str, Any], identity_field: str) -> str:
    payload = dict(value)
    payload.pop(identity_field, None)
    raw = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _argv_sha256(argv: list[str]) -> str:
    if (
        not isinstance(argv, list)
        or not argv
        or any(not isinstance(item, str) or not item for item in argv)
    ):
        raise HardwareGateError("argv identity requires explicit non-empty strings")
    raw = json.dumps(
        argv,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _require_sha256(name: str, value: Any) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise HardwareGateError(f"{name} must be lowercase SHA-256")
    return value


def _text(name: str, value: Any) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or _SAFE_TEXT.fullmatch(value) is None
    ):
        raise HardwareGateError(f"invalid {name}")
    return value


def _int(name: str, value: Any, *, minimum: int = 0, maximum: int = 10**15) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise HardwareGateError(f"invalid {name}")
    return value


@dataclass(frozen=True)
class HardwareContract:
    contract_sha256: str
    selection_sha256: str
    offer_type: str
    provider: str
    cloud: str
    gpu_name: str
    gpu_count: int
    min_vram_bytes: int
    min_compute_major: int
    require_bf16: bool
    require_full_nvlink_mesh: bool

    @classmethod
    def from_value(cls, value: Any) -> "HardwareContract":
        if not isinstance(value, Mapping) or value.get("format") != CONTRACT_FORMAT:
            raise HardwareGateError(f"unsupported {CONTRACT_FORMAT} input")
        expected = {
            "format",
            "contract_sha256",
            "selection_sha256",
            "offer_type",
            "provider",
            "cloud",
            "gpu_name",
            "gpu_count",
            "min_vram_bytes",
            "min_compute_major",
            "require_bf16",
            "require_full_nvlink_mesh",
        }
        if set(value) != expected:
            raise HardwareGateError("hardware contract fields differ")
        declared = _require_sha256("contract_sha256", value.get("contract_sha256"))
        if _canonical_sha256(value, "contract_sha256") != declared:
            raise HardwareGateError("hardware contract identity mismatch")
        selection = _require_sha256("selection_sha256", value.get("selection_sha256"))
        gpu_name = _text("gpu_name", value.get("gpu_name")).upper()
        if gpu_name not in ALLOWED_GPU_FAMILIES:
            raise HardwareGateError("GPU family is not allowed")
        gpu_count = _int("gpu_count", value.get("gpu_count"), minimum=1, maximum=64)
        if gpu_count != WORLD:
            raise HardwareGateError("hardware gate requires exactly eight GPUs")
        min_vram = _int(
            "min_vram_bytes",
            value.get("min_vram_bytes"),
            minimum=1,
            maximum=2 * 1024**4,
        )
        min_major = _int(
            "min_compute_major",
            value.get("min_compute_major"),
            minimum=9,
            maximum=32,
        )
        for field in ("require_bf16", "require_full_nvlink_mesh"):
            if type(value.get(field)) is not bool:
                raise HardwareGateError(f"{field} must be boolean")
        return cls(
            contract_sha256=declared,
            selection_sha256=selection,
            offer_type=_text("offer_type", value.get("offer_type")),
            provider=_text("provider", value.get("provider")),
            cloud=_text("cloud", value.get("cloud")),
            gpu_name=gpu_name,
            gpu_count=gpu_count,
            min_vram_bytes=min_vram,
            min_compute_major=min_major,
            require_bf16=value["require_bf16"],
            require_full_nvlink_mesh=value["require_full_nvlink_mesh"],
        )


def load_contract(path: str | Path) -> HardwareContract:
    return HardwareContract.from_value(_load_json(path))


def _bootstrap_root() -> Path:
    return Path(__file__).resolve().parent.parent / "imc_nccl_bootstrap"


def load_pinned_supervisor():
    root = _bootstrap_root()
    if set(SUPERVISOR_SOURCE_PINS) != {"probe.py", "containment.py"}:
        raise HardwareGateError("supervisor source pin set differs")
    verified = {}
    for filename, expected in SUPERVISOR_SOURCE_PINS.items():
        path = root / filename
        if path.is_symlink() or not path.is_file():
            raise HardwareGateError("pinned supervisor source missing")
        raw = path.read_bytes()
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise HardwareGateError(
                f"pinned supervisor source drift: {filename}:{actual}"
            )
        verified[filename] = raw

    path = root / "probe.py"
    module_name = "imc_nccl_hardware_gate_pinned_probe"
    existing = sys.modules.get(module_name)
    if existing is not None:
        existing_file = getattr(existing, "__file__", None)
        if (
            not isinstance(existing_file, str)
            or Path(existing_file).resolve() != path.resolve()
            or getattr(existing, "_hardware_gate_loaded_sha256", None)
            != SUPERVISOR_SOURCE_PINS["probe.py"]
        ):
            raise HardwareGateError("pinned supervisor module identity differs")
        return existing
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None:
        raise HardwareGateError("unable to construct pinned supervisor import")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    exec(compile(verified["probe.py"], str(path), "exec"), module.__dict__)
    setattr(
        module,
        "_hardware_gate_loaded_sha256",
        SUPERVISOR_SOURCE_PINS["probe.py"],
    )
    return module


def parse_topology(raw: str, *, require_full_nvlink_mesh: bool) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise HardwareGateError("topology output must be text")
    encoded = raw.encode("utf-8")
    if not encoded or len(encoded) > MAX_TOPOLOGY_BYTES:
        raise HardwareGateError("topology output empty or exceeds byte cap")

    rows: dict[int, list[str]] = {}
    for line in raw.splitlines():
        parts = line.split()
        if not parts:
            continue
        match = _GPU_ROW.fullmatch(parts[0])
        if match is None:
            continue
        # nvidia-smi begins with a column header such as
        # "GPU0 GPU1 ... GPU7 CPU Affinity". It is not the GPU0 data row.
        if len(parts) > 1 and _GPU_ROW.fullmatch(parts[1]) is not None:
            continue
        index = int(match.group(1))
        if not 0 <= index < WORLD or index in rows:
            raise HardwareGateError("topology has duplicate/out-of-range GPU row")
        if len(parts) < WORLD + 1:
            raise HardwareGateError("topology GPU row lacks peer columns")
        peers = parts[1 : WORLD + 1]
        rows[index] = peers

    if set(rows) != set(range(WORLD)):
        raise HardwareGateError("topology must contain exactly GPU0..GPU7 rows")
    for row, peers in rows.items():
        for column, token in enumerate(peers):
            if row == column:
                if token != "X":
                    raise HardwareGateError("topology diagonal must be X")
            elif require_full_nvlink_mesh and _NVLINK.fullmatch(token) is None:
                raise HardwareGateError(
                    f"full NVLink mesh required; GPU{row}->GPU{column}={token}"
                )
            elif not token:
                raise HardwareGateError("empty topology peer token")

    normalized = [
        {"gpu": f"GPU{row}", "peers": rows[row]}
        for row in range(WORLD)
    ]
    return {
        "format": TOPOLOGY_FORMAT,
        "source": "nvidia-smi topo -m",
        "output_sha256": hashlib.sha256(encoded).hexdigest(),
        "full_nvlink_mesh_required": require_full_nvlink_mesh,
        "full_nvlink_mesh_verified": all(
            row == column or _NVLINK.fullmatch(rows[row][column]) is not None
            for row in range(WORLD)
            for column in range(WORLD)
        ),
        "rows": normalized,
    }


def _rank_entry(entry: Any, rank: int, contract: HardwareContract) -> dict[str, Any]:
    expected = {
        "rank",
        "local_rank",
        "device_index",
        "gpu_uuid",
        "name",
        "vram_bytes",
        "compute_major",
        "bf16",
    }
    if not isinstance(entry, Mapping) or set(entry) != expected:
        raise HardwareGateError("malformed rank identity")
    if (
        type(entry["rank"]) is not int
        or type(entry["local_rank"]) is not int
        or type(entry["device_index"]) is not int
        or entry["rank"] != rank
        or entry["local_rank"] != rank
        or entry["device_index"] != rank
    ):
        raise HardwareGateError("rank/device placement mismatch")
    uuid = entry["gpu_uuid"]
    if not isinstance(uuid, str) or not uuid.strip() or len(uuid) > 256:
        raise HardwareGateError("GPU UUID is missing/invalid")
    name = entry["name"]
    if (
        not isinstance(name, str)
        or contract.gpu_name.lower() not in name.lower()
    ):
        raise HardwareGateError("GPU family does not match hardware contract")
    vram = _int(
        "vram_bytes",
        entry["vram_bytes"],
        minimum=contract.min_vram_bytes,
        maximum=2 * 1024**4,
    )
    major = _int(
        "compute_major",
        entry["compute_major"],
        minimum=contract.min_compute_major,
        maximum=32,
    )
    if type(entry["bf16"]) is not bool:
        raise HardwareGateError("bf16 support flag must be boolean")
    if contract.require_bf16 and entry["bf16"] is not True:
        raise HardwareGateError("BF16 support is required")
    return {
        "rank": rank,
        "local_rank": rank,
        "device_index": rank,
        "gpu_uuid": uuid,
        "name": name,
        "vram_bytes": vram,
        "compute_major": major,
        "bf16": entry["bf16"],
    }


def validate_identity(
    payload: Any,
    contract: HardwareContract,
) -> dict[str, Any]:
    expected = {
        "format",
        "contract_sha256",
        "selection_sha256",
        "offer_type",
        "world_size",
        "backend",
        "ranks",
        "all_reduce_sum",
        "torch_version",
        "cuda_version",
        "topology",
    }
    if not isinstance(payload, Mapping) or set(payload) != expected:
        raise HardwareGateError("identity fields differ")
    if payload["format"] != IDENTITY_FORMAT:
        raise HardwareGateError("identity format differs")
    if payload["contract_sha256"] != contract.contract_sha256:
        raise HardwareGateError("identity contract binding differs")
    if payload["selection_sha256"] != contract.selection_sha256:
        raise HardwareGateError("identity selection binding differs")
    if payload["offer_type"] != contract.offer_type:
        raise HardwareGateError("identity offer binding differs")
    if (
        type(payload["world_size"]) is not int
        or payload["world_size"] != WORLD
        or payload["backend"] != "nccl"
    ):
        raise HardwareGateError("identity must prove NCCL world of eight")
    if (
        type(payload["all_reduce_sum"]) is not int
        or payload["all_reduce_sum"] != sum(range(WORLD))
    ):
        raise HardwareGateError("NCCL all-reduce proof mismatch")
    if not isinstance(payload["torch_version"], str) or not payload["torch_version"]:
        raise HardwareGateError("missing Torch version")
    if not isinstance(payload["cuda_version"], str) or not payload["cuda_version"]:
        raise HardwareGateError("missing CUDA version")

    ranks = payload["ranks"]
    if not isinstance(ranks, list) or len(ranks) != WORLD:
        raise HardwareGateError("identity must contain eight rank records")
    normalized = []
    uuids = set()
    for rank in range(WORLD):
        entry = _rank_entry(ranks[rank], rank, contract)
        if entry["gpu_uuid"] in uuids:
            raise HardwareGateError("duplicate GPU UUID")
        uuids.add(entry["gpu_uuid"])
        normalized.append(entry)

    topology = payload["topology"]
    if not isinstance(topology, Mapping):
        raise HardwareGateError("topology receipt missing")
    topo_expected = {
        "format",
        "source",
        "output_sha256",
        "full_nvlink_mesh_required",
        "full_nvlink_mesh_verified",
        "rows",
    }
    if set(topology) != topo_expected or topology.get("format") != TOPOLOGY_FORMAT:
        raise HardwareGateError("topology receipt fields/format differ")
    _require_sha256("topology output_sha256", topology.get("output_sha256"))
    if topology.get("source") != "nvidia-smi topo -m":
        raise HardwareGateError("topology source differs")
    if topology.get("full_nvlink_mesh_required") is not contract.require_full_nvlink_mesh:
        raise HardwareGateError("topology requirement binding differs")
    if contract.require_full_nvlink_mesh and topology.get("full_nvlink_mesh_verified") is not True:
        raise HardwareGateError("full NVLink mesh is not verified")
    rows = topology.get("rows")
    if not isinstance(rows, list) or len(rows) != WORLD:
        raise HardwareGateError("topology row inventory differs")
    for index, row in enumerate(rows):
        if (
            not isinstance(row, Mapping)
            or set(row) != {"gpu", "peers"}
            or row.get("gpu") != f"GPU{index}"
            or not isinstance(row.get("peers"), list)
            or len(row["peers"]) != WORLD
        ):
            raise HardwareGateError("topology normalized rows differ")
        for column, token in enumerate(row["peers"]):
            if not isinstance(token, str):
                raise HardwareGateError("topology token must be text")
            if index == column and token != "X":
                raise HardwareGateError("topology diagonal differs")
            if (
                index != column
                and contract.require_full_nvlink_mesh
                and _NVLINK.fullmatch(token) is None
            ):
                raise HardwareGateError("topology lacks full NVLink mesh")

    return {
        **dict(payload),
        "ranks": normalized,
        "topology": dict(topology),
    }


def _read_topology() -> dict[str, Any]:
    binary = shutil.which("nvidia-smi")
    if not binary:
        raise HardwareGateError("nvidia-smi is unavailable")
    try:
        result = subprocess.run(
            [binary, "topo", "-m"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HardwareGateError("nvidia-smi topology query timed out") from exc
    if result.returncode != 0:
        raise HardwareGateError("nvidia-smi topology query failed")
    if len(result.stdout.encode("utf-8")) > MAX_TOPOLOGY_BYTES:
        raise HardwareGateError("nvidia-smi topology output exceeds byte cap")
    return {"binary": str(Path(binary).resolve()), "stdout": result.stdout}


def _atomic_text(path: Path, value: str) -> None:
    if not isinstance(value, str):
        raise HardwareGateError("atomic text payload must be text")
    temp = path.with_name(path.name + ".pending")
    if temp.exists() or temp.is_symlink():
        raise HardwareGateError("atomic text temporary path already exists")
    with temp.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def identity_worker(
    contract_path: str | Path,
    output: str | Path,
    collective_timeout_seconds: float,
) -> None:
    if not sys.platform.startswith("linux"):
        raise HardwareGateError("identity worker requires Linux")
    contract = load_contract(contract_path)
    if (
        type(collective_timeout_seconds) not in (int, float)
        or not math.isfinite(collective_timeout_seconds)
        or collective_timeout_seconds <= 0
        or collective_timeout_seconds > 120
    ):
        raise HardwareGateError("collective timeout is invalid")

    gate_path = Path(__file__).resolve()
    probe = load_pinned_supervisor()
    containment = probe.containment_module()
    containment.assert_current_containment(
        expected_config_identity=contract.contract_sha256,
        expected_source_sha256=SUPERVISOR_SOURCE_PINS,
        expected_worker_source_sha256=_file_sha256(gate_path),
        expected_worker_source_path=gate_path,
        required_remaining_seconds=min(5.0, collective_timeout_seconds),
    )

    import torch
    import torch.distributed as dist
    from datetime import timedelta

    try:
        rank = int(os.environ["RANK"])
        local_rank = int(os.environ["LOCAL_RANK"])
        world = int(os.environ["WORLD_SIZE"])
    except (KeyError, ValueError) as exc:
        raise HardwareGateError("torchrun rank environment is invalid") from exc
    if (
        world != WORLD
        or not 0 <= rank < WORLD
        or local_rank != rank
        or torch.cuda.device_count() != WORLD
    ):
        raise HardwareGateError("worker placement/visible CUDA inventory differs from eight")

    torch.cuda.set_device(local_rank)
    dist.init_process_group(
        "nccl",
        timeout=timedelta(seconds=collective_timeout_seconds),
    )
    try:
        properties = torch.cuda.get_device_properties(local_rank)
        uuid = getattr(properties, "uuid", None)
        if uuid is None:
            raise HardwareGateError(
                "Torch does not expose a stable GPU UUID; hardware proof unavailable"
            )
        entry = {
            "rank": rank,
            "local_rank": local_rank,
            "device_index": torch.cuda.current_device(),
            "gpu_uuid": str(uuid),
            "name": str(properties.name),
            "vram_bytes": int(properties.total_memory),
            "compute_major": int(properties.major),
            "bf16": bool(torch.cuda.is_bf16_supported()),
        }
        ranks: list[Any] = [None] * WORLD
        dist.all_gather_object(ranks, entry)
        value = torch.tensor(rank, device=f"cuda:{local_rank}", dtype=torch.int64)
        dist.all_reduce(value)
        torch.cuda.synchronize(local_rank)

        if rank == 0:
            topology_raw = _read_topology()
            _atomic_text(Path(output) / "topology.txt", topology_raw["stdout"])
            topology = parse_topology(
                topology_raw["stdout"],
                require_full_nvlink_mesh=contract.require_full_nvlink_mesh,
            )
            payload = {
                "format": IDENTITY_FORMAT,
                "contract_sha256": contract.contract_sha256,
                "selection_sha256": contract.selection_sha256,
                "offer_type": contract.offer_type,
                "world_size": dist.get_world_size(),
                "backend": str(dist.get_backend()),
                "ranks": ranks,
                "all_reduce_sum": int(value.item()),
                "torch_version": str(torch.__version__),
                "cuda_version": str(torch.version.cuda or ""),
                "topology": topology,
            }
            validate_identity(payload, contract)
            probe = load_pinned_supervisor()
            probe.atomic_json(Path(output) / "identity.json", payload)
        dist.barrier()
    finally:
        dist.destroy_process_group()


def _deadline(value: str) -> datetime:
    if not isinstance(value, str):
        raise HardwareGateError("deadline must be text")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HardwareGateError("invalid absolute deadline") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise HardwareGateError("deadline requires timezone")
    return parsed.astimezone(timezone.utc)


def _build_worker_command(
    contract_path: Path,
    output: Path,
    collective_timeout_seconds: float,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "torch.distributed.run",
        "--standalone",
        "--nnodes=1",
        f"--nproc-per-node={WORLD}",
        "--max-restarts=0",
        str(Path(__file__).resolve()),
        "--worker",
        "--contract",
        str(contract_path),
        "--output",
        str(output),
        "--collective-timeout-seconds",
        str(collective_timeout_seconds),
    ]


def _rank_worker_argv(
    contract_path: Path,
    output: Path,
    collective_timeout_seconds: float,
) -> list[str]:
    return [
        sys.executable,
        "-u",
        str(Path(__file__).resolve()),
        "--worker",
        "--contract",
        str(contract_path),
        "--output",
        str(output),
        "--collective-timeout-seconds",
        str(collective_timeout_seconds),
    ]


def _containment_binding(
    contract: HardwareContract,
    contract_path: Path,
    output: Path,
    collective_timeout_seconds: float,
) -> dict[str, str]:
    worker = Path(__file__).resolve()
    return {
        "config_identity_sha256": contract.contract_sha256,
        "worker_source_path": str(worker),
        "worker_source_sha256": _file_sha256(worker),
        "worker_argv_sha256": _argv_sha256(
            _rank_worker_argv(
                contract_path,
                output,
                collective_timeout_seconds,
            )
        ),
    }


def execute_gate(
    *,
    contract_path: str | Path,
    output: str | Path,
    absolute_deadline: str,
    max_wall_seconds: float,
    phase_timeout_seconds: float,
    teardown_seconds: float,
    threads: int,
) -> dict[str, Any]:
    if not sys.platform.startswith("linux"):
        raise HardwareGateError("hardware execution requires Linux")
    contract_file = Path(contract_path).resolve(strict=True)
    contract = load_contract(contract_file)
    probe = load_pinned_supervisor()
    deadline = _deadline(absolute_deadline)
    limits = probe.Limits(
        deadline=deadline,
        max_wall_seconds=max_wall_seconds,
        phase_timeout_seconds=phase_timeout_seconds,
        teardown_seconds=teardown_seconds,
        threads=threads,
    )
    output_target = Path(output).absolute()
    collective_timeout = max(
        0.001,
        min(20.0, phase_timeout_seconds / 2),
    )
    binding = _containment_binding(
        contract,
        contract_file,
        output_target,
        collective_timeout,
    )
    supervisor = probe.Supervisor(limits, containment_binding=binding)
    if supervisor.remaining() <= limits.teardown_seconds + collective_timeout:
        raise HardwareGateError("fresh deadline and cleanup reserve are required")
    capability = supervisor.strict_capability()
    if (
        capability.get("format") != "imc-supervisor-capability-v1"
        or capability.get("capability_version") != "linux-subreaper-pidfd-v1"
        or capability.get("source_sha256") != SUPERVISOR_SOURCE_PINS
        or capability.get("readiness_verified") is not True
    ):
        raise HardwareGateError("pinned strict supervisor capability is unverified")

    output_path = probe.exclusive_output(output)
    receipt = {
        "format": FORMAT,
        "status": "INCOMPLETE",
        "gpu_proof": False,
        "world_size": WORLD,
        "contract_sha256": contract.contract_sha256,
        "selection_sha256": contract.selection_sha256,
        "offer_type": contract.offer_type,
        "allocation_authorized": False,
        "training_performed": False,
        "supervisor_source_sha256": dict(SUPERVISOR_SOURCE_PINS),
        "containment_capability": capability,
        "containment_binding": binding,
        "phase": None,
    }
    probe.atomic_json(output_path / "receipt.json", receipt)

    command = _build_worker_command(
        contract_file,
        output_path,
        collective_timeout,
    )
    phase = supervisor.run(
        command,
        Path(__file__).resolve().parent,
        output_path / "identity.log",
    )
    receipt["phase"] = phase
    probe.atomic_json(output_path / "receipt.json", receipt)
    if phase.get("status") != "PASS":
        raise HardwareGateError("NCCL identity phase failed or cleanup is unverified")
    identity = validate_identity(
        _load_json(output_path / "identity.json"),
        contract,
    )
    topology_path = output_path / "topology.txt"
    if (
        topology_path.is_symlink()
        or not topology_path.is_file()
        or topology_path.stat().st_size > MAX_TOPOLOGY_BYTES
    ):
        raise HardwareGateError("raw topology evidence is missing/unsafe")
    raw_topology = topology_path.read_text(encoding="utf-8")
    replayed_topology = parse_topology(
        raw_topology,
        require_full_nvlink_mesh=contract.require_full_nvlink_mesh,
    )
    if identity["topology"] != replayed_topology:
        raise HardwareGateError("identity topology differs from independent raw replay")
    receipt.update(
        status="PASS",
        gpu_proof=True,
        hardware=identity,
        topology_raw_sha256=_file_sha256(topology_path),
    )
    probe.atomic_json(output_path / "receipt.json", receipt)
    return receipt


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--local-rank", "--local_rank", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--collective-timeout-seconds", type=float, default=20, help=argparse.SUPPRESS)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--absolute-deadline")
    parser.add_argument("--max-wall-seconds", type=float, default=120)
    parser.add_argument("--phase-timeout-seconds", type=float, default=45)
    parser.add_argument("--teardown-seconds", type=float, default=10)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)

    if args.worker:
        identity_worker(
            args.contract,
            args.output,
            args.collective_timeout_seconds,
        )
        return 0

    contract = load_contract(args.contract)
    load_pinned_supervisor()
    if not args.execute:
        print(json.dumps({
            "format": FORMAT,
            "status": "DRY_RUN_ONLY",
            "gpu_proof": False,
            "world_size": WORLD,
            "contract_sha256": contract.contract_sha256,
            "selection_sha256": contract.selection_sha256,
            "offer_type": contract.offer_type,
            "expected_gpu_name": contract.gpu_name,
            "allocation_authorized": False,
            "training_performed": False,
            "supervisor_source_sha256": SUPERVISOR_SOURCE_PINS,
        }, sort_keys=True))
        return 0

    if not args.absolute_deadline:
        raise HardwareGateError("--absolute-deadline is required for execution")
    receipt = execute_gate(
        contract_path=args.contract,
        output=args.output,
        absolute_deadline=args.absolute_deadline,
        max_wall_seconds=args.max_wall_seconds,
        phase_timeout_seconds=args.phase_timeout_seconds,
        teardown_seconds=args.teardown_seconds,
        threads=args.threads,
    )
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
