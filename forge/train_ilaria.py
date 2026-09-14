"""train_ilaria.py — the forge: pretrain an Ilaria brain in PyTorch and
export it straight into the Go organism's NXTF2BIN format.

Pipeline (Go tokenizes, Python trains, Go runs):

    go run ./cmd/corpus-tokenize -tokenizer <tokenizer.json> -in <corpus.jsonl> -out <prefix>
    python forge/train_ilaria.py --data <prefix> --out data/forge/brain-v1 --steps 3000
    go run -tags gpu ./cmd/nxtf-run -data-dir data/forge/brain-v1 -gpu -prompt "Once upon a time"

Design choices (all deliberate for a GTX 1660 Ti, 6 GB, no bf16):
  - fp16 autocast + GradScaler (Turing has fp16 tensor throughput, no bf16).
  - Packed random windows of ctx+1 tokens from the flat stream — standard LM
    pretraining, no padding waste.
  - AdamW (betas 0.9/0.95), linear warmup + cosine, grad-clip 1.0, weight
    decay on matrices only (LN/bias exempt) — same policy as the Go trainer.
  - Exports NXTF2BIN at every eval, so the organism can pick up the best
    brain at any point.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ilaria_model import IlariaConfig, IlariaTransformer  # noqa: E402
from nxtf import save_nxtf  # noqa: E402


def load_stream(prefix: str):
    with open(prefix + ".json") as f:
        meta = json.load(f)
    dtype = np.uint16 if meta["dtype"] == "uint16" else np.uint32
    data = np.memmap(prefix + ".bin", dtype=dtype, mode="r")
    return data, meta


def batch_windows(data, ctx: int, bsz: int, rng: np.random.Generator, device: str):
    starts = rng.integers(0, len(data) - ctx - 1, size=bsz)
    x = np.stack([data[s:s + ctx] for s in starts]).astype(np.int64)
    y = np.stack([data[s + 1:s + ctx + 1] for s in starts]).astype(np.int64)
    return (torch.from_numpy(x).to(device, non_blocking=True),
            torch.from_numpy(y).to(device, non_blocking=True))


def lr_at(step: int, warmup: int, total: int, peak: float, floor: float) -> float:
    if step < warmup:
        return peak * (step + 1) / max(1, warmup)
    p = min(1.0, (step - warmup) / max(1, total - warmup))
    return floor + 0.5 * (peak - floor) * (1 + math.cos(math.pi * p))


def param_groups(model: IlariaTransformer, wd: float):
    decay, no_decay = [], []
    for name, p in model.named_parameters():
        (decay if p.ndim == 2 else no_decay).append(p)   # matrices decay, vectors don't
    return [{"params": decay, "weight_decay": wd}, {"params": no_decay, "weight_decay": 0.0}]


@torch.no_grad()
def evaluate(model, data, ctx, bsz, device, iters, rng):
    model.eval()
    losses = []
    for _ in range(iters):
        x, y = batch_windows(data, ctx, bsz, rng, device)
        with torch.autocast("cuda", dtype=torch.float16, enabled=device == "cuda"):
            logits = model(x)
        losses.append(F.cross_entropy(logits.float().view(-1, logits.size(-1)), y.view(-1)).item())
    model.train()
    return float(np.mean(losses))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="token stream prefix (from cmd/corpus-tokenize)")
    ap.add_argument("--out", required=True, help="output dir (transformer.nxtf + tokenizer.json copied here)")
    ap.add_argument("--tokenizer", default="", help="tokenizer.json to copy next to the brain (default: from stream meta)")
    ap.add_argument("--embed-dim", type=int, default=384)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--ffn-dim", type=int, default=1536)
    ap.add_argument("--ctx", type=int, default=512)
    ap.add_argument("--max-seq-len", type=int, default=1024)
    ap.add_argument("--rope", action="store_true")
    ap.add_argument("--swiglu", action="store_true")
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--batch", type=int, default=16, help="sequences per micro-batch")
    ap.add_argument("--accum", type=int, default=1, help="gradient accumulation steps")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--warmup", type=int, default=200)
    ap.add_argument("--lr", type=float, default=6e-4)
    ap.add_argument("--min-lr", type=float, default=6e-5)
    ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--eval-iters", type=int, default=20)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resume", default="", help="checkpoint .pt to resume from")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    data, meta = load_stream(args.data)
    n_val = max(args.ctx * 50, len(data) // 100)          # ~1% held out, ≥50 windows
    train_data, val_data = data[:-n_val], data[-n_val:]
    print(f"[forge] tokens: {len(data):,} (train {len(train_data):,} / val {len(val_data):,}) "
          f"vocab {meta['vocab_size']} eos {meta['eos_id']} device {device}")

    cfg = IlariaConfig(vocab_size=meta["vocab_size"], embed_dim=args.embed_dim,
                       num_heads=args.heads, num_layers=args.layers, ffn_dim=args.ffn_dim,
                       max_seq_len=args.max_seq_len, eos_token_id=meta["eos_id"],
                       dropout_rate=args.dropout, use_rope=args.rope, use_swiglu=args.swiglu)
    model = IlariaTransformer(cfg).to(device)
    print(f"[forge] model: {model.param_count()/1e6:.1f}M params | rope={cfg.use_rope} swiglu={cfg.use_swiglu} "
          f"ctx={args.ctx} batch={args.batch}x{args.accum}")

    opt = torch.optim.AdamW(param_groups(model, args.wd), lr=args.lr, betas=(0.9, 0.95), eps=1e-8)
    scaler = torch.cuda.amp.GradScaler(enabled=device == "cuda")
    start_step, best_val = 0, float("inf")
    if args.resume:
        ck = torch.load(args.resume, map_location=device)
        model.load_state_dict(ck["model"]); opt.load_state_dict(ck["opt"])
        start_step, best_val = ck["step"], ck.get("best_val", best_val)
        print(f"[forge] resumed from {args.resume} @ step {start_step}")

    os.makedirs(args.out, exist_ok=True)
    tok_src = args.tokenizer or meta.get("tokenizer", "")
    if tok_src and os.path.exists(tok_src):
        import shutil
        shutil.copy(tok_src, os.path.join(args.out, "tokenizer.json"))

    log = open(os.path.join(args.out, "training.log"), "a")
    model.train()
    t0 = time.time()
    tokens_seen = 0
    for step in range(start_step, args.steps):
        lr = lr_at(step, args.warmup, args.steps, args.lr, args.min_lr)
        for g in opt.param_groups:
            g["lr"] = lr
        opt.zero_grad(set_to_none=True)
        loss_acc = 0.0
        for _ in range(args.accum):
            x, y = batch_windows(train_data, args.ctx, args.batch, rng, device)
            with torch.autocast("cuda", dtype=torch.float16, enabled=device == "cuda"):
                logits = model(x)
                loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1)) / args.accum
            scaler.scale(loss).backward()
            loss_acc += loss.item()
            tokens_seen += x.numel()
        scaler.unscale_(opt)
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt); scaler.update()

        if step % 20 == 0:
            el = time.time() - t0
            print(f"step {step:6d} | loss {loss_acc:.4f} | lr {lr:.2e} | gn {gn:.2f} | "
                  f"{tokens_seen/max(el,1e-9):,.0f} tok/s | {el/60:.1f} min")
        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            val = evaluate(model, val_data, args.ctx, args.batch, device, args.eval_iters, rng)
            improved = val < best_val
            best_val = min(best_val, val)
            print(f"[eval] step {step+1} val_loss {val:.4f} ppl {math.exp(val):.1f} "
                  f"{'(new best, exported)' if improved else ''}")
            log.write(json.dumps({"step": step + 1, "train_loss": loss_acc, "val_loss": val,
                                  "ppl": math.exp(val), "lr": lr, "tokens": tokens_seen}) + "\n")
            log.flush()
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(),
                        "step": step + 1, "best_val": best_val, "cfg": cfg.__dict__},
                       os.path.join(args.out, "checkpoint.pt"))
            if improved:
                save_nxtf(model, os.path.join(args.out, "transformer.nxtf"))

    # Sanity sample straight from the forge (greedy, token ids only — the
    # organism decodes; Go owns the tokenizer).
    ids = model.generate_greedy([meta["eos_id"]], 30)
    print(f"[forge] greedy sample ids: {ids}")
    print(f"[forge] DONE — best val {best_val:.4f} (ppl {math.exp(best_val):.1f}) → {args.out}/transformer.nxtf".replace("→", "->"))


if __name__ == "__main__":
    main()
