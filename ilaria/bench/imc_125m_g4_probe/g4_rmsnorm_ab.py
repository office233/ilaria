from __future__ import annotations

import gc
import json
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F

ROOT = Path("/content/ilaria-g4-throughput")
FORGE = ROOT / "forge"
sys.path.insert(0, str(FORGE))

import imc_model
from imc_model import ImcConfig, ImcTransformer
from train_ilaria import param_groups

VOCAB = 65_536
EOS = 61_440
CTX = 2_048
BATCH = 32
ACCUM = 4
TOKENS = CTX * BATCH * ACCUM


def make_model():
    torch.manual_seed(1250007)
    torch.cuda.manual_seed_all(1250007)
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
    opt = torch.optim.AdamW(
        param_groups(model, 0.1),
        lr=6e-4,
        betas=(0.9, 0.95),
        eps=1e-8,
    )
    return model, opt


def step(model, opt, seed):
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    opt.zero_grad(set_to_none=True)
    total_loss = 0.0
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    for _ in range(ACCUM):
        ids = torch.randint(0, VOCAB, (BATCH, CTX), device="cuda")
        targets = torch.roll(ids, -1, dims=1)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = model(ids, targets) / ACCUM
        loss.backward()
        total_loss += float(loss.detach().cpu())
    grad = torch.nn.utils.clip_grad_norm_(
        model.parameters(), 1.0, error_if_nonfinite=True
    )
    opt.step()
    torch.cuda.synchronize()
    seconds = time.perf_counter() - t0
    return {
        "seconds": seconds,
        "tokens_per_second": TOKENS / seconds,
        "loss": total_loss,
        "grad_norm": float(grad.detach().cpu()),
        "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
    }


def run_variant(name, forward_impl=None):
    original = imc_model.RMSNorm.forward
    if forward_impl is not None:
        imc_model.RMSNorm.forward = forward_impl
    try:
        model, opt = make_model()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        warmup = step(model, opt, 1250007)
        torch.cuda.reset_peak_memory_stats()
        measured = step(model, opt, 1250008)
        return {"name": name, "warmup": warmup, "measured": measured}
    finally:
        imc_model.RMSNorm.forward = original
        if "model" in locals():
            del model, opt
        gc.collect()
        torch.cuda.empty_cache()


def bf16_weight_forward(self, x):
    weight = self.weight
    if weight.dtype != x.dtype:
        weight = weight.to(dtype=x.dtype)
    return F.rms_norm(x, x.shape[-1:], weight, self.eps)


def main():
    props = torch.cuda.get_device_properties(0)
    if "RTX PRO 6000 Blackwell" not in props.name:
        raise SystemExit(f"not G4 Blackwell: {props.name}")
    baseline = run_variant("fp32_rms_weight")
    fused = run_variant("bf16_rms_weight", bf16_weight_forward)
    out = {
        "format": "imc-125m-g4-rmsnorm-ab-v1",
        "device": props.name,
        "tokens_per_step": TOKENS,
        "variants": [baseline, fused],
        "speedup": (
            fused["measured"]["tokens_per_second"]
            / baseline["measured"]["tokens_per_second"]
        ),
        "loss_delta": fused["measured"]["loss"] - baseline["measured"]["loss"],
        "grad_norm_delta": (
            fused["measured"]["grad_norm"] - baseline["measured"]["grad_norm"]
        ),
    }
    print(json.dumps(out, indent=2, sort_keys=True))
    Path("/content/g4-rmsnorm-ab.json").write_text(
        json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
