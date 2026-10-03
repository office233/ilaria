from __future__ import annotations

import pytest

from gpu_preflight import assess_gpu_report


def report(*, count=1, memory_gib=80, major=9, bf16=True):
    return {
        "format": "imc-gpu-preflight-v1",
        "torch_version": "test",
        "cuda_runtime": "test",
        "cuda_available": count > 0,
        "device_count": count,
        "devices": [
            {
                "index": index,
                "name": "fixture-gpu",
                "total_memory_bytes": memory_gib * 1024**3,
                "compute_capability": [major, 0],
                "bf16_native": bf16,
            }
            for index in range(count)
        ],
    }


def test_h100_like_device_passes_serious_single_gpu_gate():
    assessed = assess_gpu_report(
        report(), world_size=1, min_vram_gib=24, require_bf16=True
    )
    assert assessed["ready"] is True
    assert assessed["blockers"] == []


def test_cpu_only_runtime_fails_closed():
    assessed = assess_gpu_report(report(count=0), world_size=1)
    assert assessed["ready"] is False
    assert "cuda_unavailable" in assessed["blockers"]
    assert "gpu_count:0<1" in assessed["blockers"]


def test_insufficient_multi_gpu_inventory_fails():
    assessed = assess_gpu_report(report(count=1), world_size=2)
    assert assessed["ready"] is False
    assert "gpu_count:1<2" in assessed["blockers"]


def test_low_vram_or_capability_fails():
    assessed = assess_gpu_report(
        report(memory_gib=16, major=6), world_size=1, min_vram_gib=24
    )
    assert assessed["ready"] is False
    assert any("vram_below" in blocker for blocker in assessed["blockers"])
    assert any("compute_capability_below" in blocker for blocker in assessed["blockers"])


def test_bf16_requirement_is_optional_but_enforceable():
    no_bf16 = report(major=7, bf16=False)
    assert assess_gpu_report(no_bf16, world_size=1, require_bf16=False)["ready"] is True
    assessed = assess_gpu_report(no_bf16, world_size=1, require_bf16=True)
    assert assessed["ready"] is False
    assert "gpu0:bf16_not_native" in assessed["blockers"]


def test_gpu_name_requirement_is_fail_closed():
    g4 = report(memory_gib=95, major=12, bf16=True)
    g4["devices"][0]["name"] = "NVIDIA RTX PRO 6000 Blackwell Server Edition"
    assessed = assess_gpu_report(
        g4,
        world_size=1,
        min_vram_gib=90,
        min_compute_major=12,
        require_bf16=True,
        require_name_contains="RTX PRO 6000 Blackwell",
    )
    assert assessed["ready"] is True
    assert assessed["blockers"] == []

    wrong = report(memory_gib=95, major=12, bf16=True)
    assessed = assess_gpu_report(
        wrong,
        world_size=1,
        require_name_contains="RTX PRO 6000 Blackwell",
    )
    assert assessed["ready"] is False
    assert "gpu0:name_missing=RTX PRO 6000 Blackwell" in assessed["blockers"]


def test_invalid_world_size_rejected():
    with pytest.raises(ValueError, match="world_size"):
        assess_gpu_report(report(), world_size=0)
