from __future__ import annotations

import argparse
import gc
import json
import math
import sys
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[2]
FORGE = ROOT / "forge"
sys.path.insert(0, str(FORGE))

from imc_model import ImcConfig, ImcTransformer  # noqa: E402
from train_ilaria import param_groups  # noqa: E402


EXPECTED_PARAMS = 125_882_112
VOCAB_SIZE = 65_536
EOS_ID = 61_440
CTX = 2_048
GLOBAL_BATCH_TOKENS = 262_144


def run_candidate(batch: int) -> dict:
    if 128 % batch:
        raise ValueError(f"micro-batch {batch} cannot realize the locked global batch")
    accum = 128 // batch
    torch.manual_seed(1250007)
    torch.cuda.manual_seed_all(1250007)
    cfg = ImcConfig.preset(
        "imc-125m",
        vocab_size=VOCAB_SIZE,
        eos_token_id=EOS_ID,
        max_seq_len=CTX,
        ternary=True,
    )
    model = ImcTransformer(cfg).cuda()
    model.enable_gradient_checkpointing(True)
    model.train()
    if model.param_count() != EXPECTED_PARAMS:
        raise RuntimeError("IMC-125M parameter count drifted")
    opt = torch.optim.AdamW(
        param_groups(model, 0.1),
        lr=6e-4,
        betas=(0.9, 0.95),
        eps=1e-8,
    )
    ids = torch.randint(0, VOCAB_SIZE, (batch, CTX), device="cuda")
    targets = torch.roll(ids, shifts=-1, dims=1)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    opt.zero_grad(set_to_none=True)
    try:
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = model(ids, targets) / accum
        loss.backward()
        grad_norm = torch.nn.utils.clip_grad_norm_(
            model.parameters(), 1.0, error_if_nonfinite=True
        )
        opt.step()
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        peak = torch.cuda.max_memory_allocated()
        return {
            "micro_batch": batch,
            "accum": accum,
            "success": True,
            "loss": float(loss.detach().cpu()) * accum,
            "grad_norm": float(grad_norm.detach().cpu()),
            "elapsed_seconds": elapsed,
            "micro_tokens": batch * CTX,
            "micro_tokens_per_second": (batch * CTX) / elapsed,
            "peak_allocated_bytes": peak,
        }
    except torch.OutOfMemoryError as exc:
        return {
            "micro_batch": batch,
            "accum": accum,
            "success": False,
            "error": "cuda_out_of_memory",
            "detail": str(exc),
            "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
        }
    finally:
        del ids, targets, opt, model
        if "loss" in locals():
            del loss
        gc.collect()
        torch.cuda.empty_cache()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--batches",
        default="4,8,16,32",
        help="comma-separated micro-batches; each must divide 128",
    )
    parser.add_argument("--max-vram-utilization", type=float, default=0.85)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    props = torch.cuda.get_device_properties(0)
    major, minor = torch.cuda.get_device_capability(0)
    name = props.name
    total_memory = int(props.total_memory)
    if "RTX PRO 6000 Blackwell" not in name:
        raise SystemExit(f"refusing non-G4 target: {name}")
    if major < 12:
        raise SystemExit(f"refusing compute capability {major}.{minor}; need >=12.0")
    if total_memory < 90 * 1024**3:
        raise SystemExit(
            f"refusing G4 runtime with insufficient VRAM: {total_memory / 1024**3:.2f} GiB"
        )
    if not torch.cuda.is_bf16_supported():
        raise SystemExit("refusing G4 runtime without native BF16")

    batches = [int(item) for item in args.batches.split(",") if item.strip()]
    if not batches or any(batch < 1 or 128 % batch for batch in batches):
        raise SystemExit("every micro-batch must be a positive divisor of 128")
    if not 0 < args.max_vram_utilization < 1:
        raise SystemExit("--max-vram-utilization must be between 0 and 1")

    results = []
    for batch in batches:
        print(f"[g4-probe] micro_batch={batch}", flush=True)
        results.append(run_candidate(batch))

    memory_ceiling = int(total_memory * args.max_vram_utilization)
    stable = [
        item
        for item in results
        if item["success"] and int(item["peak_allocated_bytes"]) <= memory_ceiling
    ]
    recommended = max(stable, key=lambda item: item["micro_batch"]) if stable else None
    report = {
        "format": "imc-125m-g4-batch-probe-v1",
        "device": {
            "name": name,
            "total_memory_bytes": total_memory,
            "compute_capability": [major, minor],
            "bf16_native": bool(torch.cuda.is_bf16_supported()),
        },
        "model": {
            "preset": "imc-125m",
            "parameters": EXPECTED_PARAMS,
            "context": CTX,
            "ternary": True,
        },
        "global_batch_tokens": GLOBAL_BATCH_TOKENS,
        "max_vram_utilization": args.max_vram_utilization,
        "results": results,
        "recommended": (
            {
                "micro_batch": recommended["micro_batch"],
                "accum": recommended["accum"],
                "peak_allocated_bytes": recommended["peak_allocated_bytes"],
            }
            if recommended
            else None
        ),
    }
    payload = json.dumps(report, indent=2, sort_keys=True)
    print(payload)
    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
    if recommended is None:
        raise SystemExit("no G4 micro-batch candidate passed with required VRAM headroom")


if __name__ == "__main__":
    main()
