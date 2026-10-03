from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root

import torch

ROOT = ilaria_root(__file__)
FORGE = ROOT / "forge"
sys.path.insert(0, str(FORGE))

from imc_model import ImcConfig, ImcTransformer
from train_ilaria import param_groups

VOCAB = 65_536
EOS = 61_440
CTX = 2_048
MICRO_BATCH = 32
ACCUM = 4
TOKENS_PER_STEP = CTX * MICRO_BATCH * ACCUM
EXPECTED_PARAMS = 125_882_112


def optimizer_step(model, opt, *, seed: int) -> tuple[float, float]:
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    opt.zero_grad(set_to_none=True)
    total_loss = 0.0
    started = time.perf_counter()
    for micro in range(ACCUM):
        ids = torch.randint(0, VOCAB, (MICRO_BATCH, CTX), device="cuda")
        targets = torch.roll(ids, -1, dims=1)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = model(ids, targets) / ACCUM
        loss.backward()
        total_loss += float(loss.detach().cpu())
        del ids, targets, loss
    grad_norm = torch.nn.utils.clip_grad_norm_(
        model.parameters(), 1.0, error_if_nonfinite=True
    )
    opt.step()
    torch.cuda.synchronize()
    return time.perf_counter() - started, float(grad_norm.detach().cpu())


def main():
    parser = argparse.ArgumentParser(description="Locked G4 full-step benchmark with explicit output.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    props = torch.cuda.get_device_properties(0)
    if "RTX PRO 6000 Blackwell" not in props.name:
        raise SystemExit(f"not G4 Blackwell: {props.name}")

    cfg = ImcConfig.preset(
        "imc-125m",
        vocab_size=VOCAB,
        eos_token_id=EOS,
        max_seq_len=CTX,
        ternary=True,
    )
    model = ImcTransformer(cfg).cuda()
    model.enable_gradient_checkpointing(True)
    model.train()
    if model.param_count() != EXPECTED_PARAMS:
        raise RuntimeError("parameter count drift")
    opt = torch.optim.AdamW(
        param_groups(model, 0.1),
        lr=6e-4,
        betas=(0.9, 0.95),
        eps=1e-8,
    )

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    warmup_seconds, warmup_grad = optimizer_step(model, opt, seed=1250007)
    torch.cuda.reset_peak_memory_stats()
    measured_seconds, measured_grad = optimizer_step(model, opt, seed=1250008)
    peak = torch.cuda.max_memory_allocated()

    result = {
        "format": "imc-125m-g4-full-step-benchmark-v1",
        "device": props.name,
        "parameters": model.param_count(),
        "context": CTX,
        "micro_batch": MICRO_BATCH,
        "accum": ACCUM,
        "tokens_per_step": TOKENS_PER_STEP,
        "warmup_seconds": warmup_seconds,
        "warmup_grad_norm": warmup_grad,
        "measured_seconds": measured_seconds,
        "measured_grad_norm": measured_grad,
        "tokens_per_second": TOKENS_PER_STEP / measured_seconds,
        "peak_allocated_bytes": peak,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
