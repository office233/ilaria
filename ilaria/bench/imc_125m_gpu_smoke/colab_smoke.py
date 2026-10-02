from __future__ import annotations

import argparse
import gc
import json
import time
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "forge"))
from imc_model import ImcConfig, ImcTransformer

EXPECTED_PARAMS = 125_882_112
VOCAB_SIZE = 65_536
SEQ_LEN = 64
BATCH = 1


def run_variant(ternary: bool) -> dict:
    torch.manual_seed(1250007)
    torch.cuda.manual_seed_all(1250007)
    cfg = ImcConfig.preset(
        "imc-125m",
        vocab_size=VOCAB_SIZE,
        eos_token_id=0,
        max_seq_len=2048,
        ternary=ternary,
    )
    model = ImcTransformer(cfg).cuda()
    model.train()
    model.enable_gradient_checkpointing(True)
    params = model.param_count()
    if params != EXPECTED_PARAMS:
        raise RuntimeError(f"parameter count drift: {params} != {EXPECTED_PARAMS}")

    ids = torch.randint(0, VOCAB_SIZE, (BATCH, SEQ_LEN), device="cuda")
    targets = torch.roll(ids, shifts=-1, dims=1)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    start = time.perf_counter()
    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
        loss = model(ids, targets, loss_chunk_tokens=SEQ_LEN)
    loss.backward()
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - start
    peak = torch.cuda.max_memory_allocated()
    result = {
        "variant": "ternary" if ternary else "full_precision",
        "parameters": params,
        "batch": BATCH,
        "sequence_length": SEQ_LEN,
        "tokens": BATCH * SEQ_LEN,
        "loss": float(loss.detach().cpu()),
        "elapsed_seconds": elapsed,
        "tokens_per_second": (BATCH * SEQ_LEN) / elapsed,
        "peak_allocated_bytes": peak,
        "finite_loss": bool(torch.isfinite(loss.detach()).item()),
    }
    del loss, targets, ids, model
    gc.collect()
    torch.cuda.empty_cache()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Locked synthetic IMC GPU smoke; output path is explicit.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available")
    device = torch.cuda.get_device_properties(0)
    results = {
        "format": "imc-125m-colab-smoke-v1",
        "torch_version": torch.__version__,
        "cuda_version": torch.version.cuda,
        "device": {
            "name": device.name,
            "total_memory_bytes": device.total_memory,
            "capability": list(torch.cuda.get_device_capability(0)),
        },
        "variants": [run_variant(False), run_variant(True)],
    }
    if not all(item["finite_loss"] for item in results["variants"]):
        raise RuntimeError("non-finite loss in GPU smoke")
    path = args.out
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
