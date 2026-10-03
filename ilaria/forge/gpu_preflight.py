"""Fail-closed CUDA hardware probe for serious IMC training launches."""
from __future__ import annotations

import argparse
import json

import torch

GPU_PREFLIGHT_FORMAT = "imc-gpu-preflight-v1"


def probe_torch_cuda() -> dict:
    devices = []
    if torch.cuda.is_available():
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            major, minor = torch.cuda.get_device_capability(index)
            devices.append(
                {
                    "index": index,
                    "name": props.name,
                    "total_memory_bytes": int(props.total_memory),
                    "compute_capability": [int(major), int(minor)],
                    "bf16_native": int(major) >= 8,
                }
            )
    return {
        "format": GPU_PREFLIGHT_FORMAT,
        "torch_version": str(torch.__version__),
        "cuda_runtime": str(torch.version.cuda) if torch.version.cuda else None,
        "cuda_available": bool(torch.cuda.is_available()),
        "device_count": len(devices),
        "devices": devices,
    }


def assess_gpu_report(
    report: dict,
    *,
    world_size: int,
    min_vram_gib: float = 24.0,
    min_compute_major: int = 7,
    require_bf16: bool = False,
    require_name_contains: str = "",
) -> dict:
    if type(world_size) is not int or world_size < 1:
        raise ValueError("world_size must be a positive integer")
    if not isinstance(min_vram_gib, (int, float)) or min_vram_gib <= 0:
        raise ValueError("min_vram_gib must be positive")
    if type(min_compute_major) is not int or min_compute_major < 1:
        raise ValueError("min_compute_major must be a positive integer")
    if type(require_bf16) is not bool:
        raise ValueError("require_bf16 must be boolean")
    if not isinstance(require_name_contains, str):
        raise ValueError("require_name_contains must be a string")

    blockers: list[str] = []
    devices = report.get("devices") if isinstance(report, dict) else None
    if report.get("cuda_available") is not True:
        blockers.append("cuda_unavailable")
        devices = []
    if not isinstance(devices, list):
        blockers.append("invalid_device_inventory")
        devices = []
    if len(devices) < world_size:
        blockers.append(f"gpu_count:{len(devices)}<{world_size}")

    minimum_bytes = int(float(min_vram_gib) * 1024**3)
    for device in devices[:world_size]:
        index = device.get("index", "?")
        memory = device.get("total_memory_bytes")
        if type(memory) is not int or memory < minimum_bytes:
            blockers.append(f"gpu{index}:vram_below_{min_vram_gib:g}GiB")
        capability = device.get("compute_capability")
        if (
            not isinstance(capability, list)
            or len(capability) != 2
            or type(capability[0]) is not int
            or capability[0] < min_compute_major
        ):
            blockers.append(f"gpu{index}:compute_capability_below_{min_compute_major}.0")
        if require_bf16 and device.get("bf16_native") is not True:
            blockers.append(f"gpu{index}:bf16_not_native")
        if require_name_contains:
            name = device.get("name")
            if not isinstance(name, str) or require_name_contains.casefold() not in name.casefold():
                blockers.append(f"gpu{index}:name_missing={require_name_contains}")

    return {
        **report,
        "ready": not blockers,
        "requirements": {
            "world_size": world_size,
            "min_vram_gib": float(min_vram_gib),
            "min_compute_major": min_compute_major,
            "require_bf16": require_bf16,
            "require_name_contains": require_name_contains,
        },
        "blockers": blockers,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--world-size", type=int, default=1)
    parser.add_argument("--min-vram-gib", type=float, default=24.0)
    parser.add_argument("--min-compute-major", type=int, default=7)
    parser.add_argument("--require-bf16", action="store_true")
    parser.add_argument("--require-name-contains", default="")
    args = parser.parse_args()
    report = assess_gpu_report(
        probe_torch_cuda(),
        world_size=args.world_size,
        min_vram_gib=args.min_vram_gib,
        min_compute_major=args.min_compute_major,
        require_bf16=args.require_bf16,
        require_name_contains=args.require_name_contains,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
