from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import pytest

import gate


def seal(value):
    value = dict(value)
    value["contract_sha256"] = gate._canonical_sha256(value, "contract_sha256")
    return value


def contract_value(**updates):
    value = {
        "format": gate.CONTRACT_FORMAT,
        "selection_sha256": "a" * 64,
        "offer_type": "oci.h100x8.sxm",
        "provider": "oci",
        "cloud": "oci",
        "gpu_name": "H100",
        "gpu_count": 8,
        "min_vram_bytes": 80 * 1024**3,
        "min_compute_major": 9,
        "require_bf16": True,
        "require_full_nvlink_mesh": True,
    }
    value.update(updates)
    return seal(value)


def write_contract(tmp_path: Path, **updates):
    path = tmp_path / "contract.json"
    path.write_text(json.dumps(contract_value(**updates), sort_keys=True) + "\n")
    return path


def topology(*, bad_pair=None):
    rows = []
    for row in range(8):
        peers = []
        for column in range(8):
            token = "X" if row == column else "NV18"
            if bad_pair == (row, column):
                token = "PHB"
            peers.append(token)
        rows.append({"gpu": f"GPU{row}", "peers": peers})
    return {
        "format": gate.TOPOLOGY_FORMAT,
        "source": "nvidia-smi topo -m",
        "output_sha256": "b" * 64,
        "full_nvlink_mesh_required": True,
        "full_nvlink_mesh_verified": bad_pair is None,
        "rows": rows,
    }


def identity(*, gpu_name="NVIDIA H100 80GB HBM3", bad_pair=None):
    return {
        "format": gate.IDENTITY_FORMAT,
        "contract_sha256": contract_value()["contract_sha256"],
        "selection_sha256": "a" * 64,
        "offer_type": "oci.h100x8.sxm",
        "world_size": 8,
        "backend": "nccl",
        "ranks": [
            {
                "rank": rank,
                "local_rank": rank,
                "device_index": rank,
                "gpu_uuid": f"GPU-unique-{rank}",
                "name": gpu_name,
                "vram_bytes": 80 * 1024**3,
                "compute_major": 9,
                "bf16": True,
            }
            for rank in range(8)
        ],
        "all_reduce_sum": 28,
        "torch_version": "2.x",
        "cuda_version": "13.x",
        "topology": topology(bad_pair=bad_pair),
    }


def topo_text(*, bad_pair=None):
    lines = ["        " + " ".join(f"GPU{i}" for i in range(8)) + " CPU Affinity"]
    for row in range(8):
        cells = []
        for column in range(8):
            token = "X" if row == column else "NV18"
            if bad_pair == (row, column):
                token = "PHB"
            cells.append(token)
        lines.append(f"GPU{row}    " + " ".join(cells) + " 0-111")
    lines.append("Legend:")
    lines.append("  X = Self")
    return "\n".join(lines) + "\n"


def test_valid_h100_world8_identity_and_nvlink_mesh_pass():
    contract = gate.HardwareContract.from_value(contract_value())
    result = gate.validate_identity(identity(), contract)
    assert result["world_size"] == 8
    assert len({item["gpu_uuid"] for item in result["ranks"]}) == 8
    assert result["topology"]["full_nvlink_mesh_verified"] is True


def test_h200_receipt_rejected_under_h100_contract():
    contract = gate.HardwareContract.from_value(contract_value())
    with pytest.raises(gate.HardwareGateError, match="GPU family"):
        gate.validate_identity(identity(gpu_name="NVIDIA H200"), contract)


@pytest.mark.parametrize(
    "fault",
    ["world-float", "sum-float", "duplicate-uuid", "low-vram", "low-major", "no-bf16"],
)
def test_identity_fail_closed(fault):
    contract = gate.HardwareContract.from_value(contract_value())
    value = identity()
    if fault == "world-float":
        value["world_size"] = 8.0
    elif fault == "sum-float":
        value["all_reduce_sum"] = 28.0
    elif fault == "duplicate-uuid":
        value["ranks"][1]["gpu_uuid"] = value["ranks"][0]["gpu_uuid"]
    elif fault == "low-vram":
        value["ranks"][1]["vram_bytes"] = 79 * 1024**3
    elif fault == "low-major":
        value["ranks"][1]["compute_major"] = 8
    else:
        value["ranks"][1]["bf16"] = False
    with pytest.raises(gate.HardwareGateError):
        gate.validate_identity(value, contract)


def test_topology_parser_accepts_full_nvlink_mesh():
    result = gate.parse_topology(topo_text(), require_full_nvlink_mesh=True)
    assert result["full_nvlink_mesh_verified"] is True
    assert len(result["rows"]) == 8


def test_topology_parser_rejects_phb_when_full_mesh_required():
    with pytest.raises(gate.HardwareGateError, match="full NVLink mesh"):
        gate.parse_topology(topo_text(bad_pair=(0, 1)), require_full_nvlink_mesh=True)


def test_topology_parser_can_report_non_full_mesh_when_contract_does_not_require_it():
    result = gate.parse_topology(
        topo_text(bad_pair=(0, 1)),
        require_full_nvlink_mesh=False,
    )
    assert result["full_nvlink_mesh_required"] is False
    assert result["full_nvlink_mesh_verified"] is False


def test_topology_parser_rejects_missing_duplicate_or_bad_diagonal():
    missing = "\n".join(topo_text().splitlines()[:-3]) + "\n"
    with pytest.raises(gate.HardwareGateError):
        gate.parse_topology(missing, require_full_nvlink_mesh=True)
    duplicate = topo_text() + topo_text().splitlines()[1] + "\n"
    with pytest.raises(gate.HardwareGateError):
        gate.parse_topology(duplicate, require_full_nvlink_mesh=True)
    bad = topo_text().replace("GPU0    X ", "GPU0    NV18 ", 1)
    with pytest.raises(gate.HardwareGateError, match="diagonal"):
        gate.parse_topology(bad, require_full_nvlink_mesh=True)


@pytest.mark.parametrize(
    "updates",
    [
        {"gpu_count": 7},
        {"gpu_count": True},
        {"gpu_name": "A100"},
        {"selection_sha256": "not-a-sha"},
        {"min_compute_major": 8},
        {"require_bf16": 1},
        {"require_full_nvlink_mesh": None},
    ],
)
def test_contract_rejects_malformed_or_broadened_scope(updates):
    value = contract_value(**updates)
    with pytest.raises(gate.HardwareGateError):
        gate.HardwareContract.from_value(value)


def test_contract_identity_tamper_rejected():
    value = contract_value()
    value["offer_type"] = "other"
    with pytest.raises(gate.HardwareGateError, match="identity mismatch"):
        gate.HardwareContract.from_value(value)


def test_pinned_supervisor_loader_matches_accepted_sources():
    module = gate.load_pinned_supervisor()
    module_file = getattr(module, "__file__", None)
    assert isinstance(module_file, str)
    root = Path(module_file).resolve().parent
    for filename, expected in gate.SUPERVISOR_SOURCE_PINS.items():
        assert hashlib.sha256((root / filename).read_bytes()).hexdigest() == expected
    assert module.WORLD == 8


def test_dry_run_does_not_import_torch_or_create_output(tmp_path, monkeypatch, capsys):
    path = write_contract(tmp_path)
    output = tmp_path / "out"
    before = set(__import__("sys").modules)
    assert gate.main([
        "--contract", str(path),
        "--output", str(output),
    ]) == 0
    assert not output.exists()
    assert "torch" not in set(__import__("sys").modules) - before
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["status"] == "DRY_RUN_ONLY"
    assert receipt["gpu_proof"] is False
    assert receipt["allocation_authorized"] is False


def test_execute_rejects_non_linux_before_gpu_import(tmp_path, monkeypatch):
    path = write_contract(tmp_path)
    monkeypatch.setattr(gate.sys, "platform", "win32")
    with pytest.raises(gate.HardwareGateError, match="requires Linux"):
        gate.execute_gate(
            contract_path=path,
            output=tmp_path / "out",
            absolute_deadline="2030-01-01T00:00:00Z",
            max_wall_seconds=30,
            phase_timeout_seconds=10,
            teardown_seconds=5,
            threads=1,
        )


def test_worker_command_is_exact_world8_torchrun(tmp_path):
    contract = tmp_path / "contract.json"
    output = tmp_path / "out"
    command = gate._build_worker_command(contract, output, 10)
    assert command[:4] == [gate.sys.executable, "-m", "torch.distributed.run", "--standalone"]
    assert "--nproc-per-node=8" in command
    assert "--max-restarts=0" in command
    assert "--worker" in command
    assert command.count(str(contract)) == 1
    assert command.count(str(output)) == 1


def test_rank_worker_binding_pins_contract_source_and_exact_argv(tmp_path):
    path = write_contract(tmp_path)
    contract = gate.load_contract(path)
    output = tmp_path / "out"
    binding = gate._containment_binding(contract, path.resolve(), output.absolute(), 10.0)
    assert binding["config_identity_sha256"] == contract.contract_sha256
    assert binding["worker_source_path"] == str(Path(gate.__file__).resolve())
    assert binding["worker_source_sha256"] == hashlib.sha256(
        Path(gate.__file__).read_bytes()
    ).hexdigest()
    expected = gate._rank_worker_argv(path.resolve(), output.absolute(), 10.0)
    assert binding["worker_argv_sha256"] == gate._argv_sha256(expected)
