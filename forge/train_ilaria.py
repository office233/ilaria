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
import contextlib
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ilaria_model import IlariaConfig, IlariaTransformer  # noqa: E402
from imc_model import PRESETS, ImcConfig, ImcTransformer, save_imc  # noqa: E402
from nxtf import save_nxtf  # noqa: E402
from atomic_io import atomic_binary_writer  # noqa: E402
from training_state import (file_sha256, training_signature, make_checkpoint,
                            restore_checkpoint, initialize_weights)  # noqa: E402


def load_stream(prefix: str):
    with open(prefix + ".json") as f:
        meta = json.load(f)
    dtypes = {"uint16": np.dtype("<u2"), "uint32": np.dtype("<u4")}
    if meta.get("dtype") not in dtypes:
        raise ValueError(f"unsupported token stream dtype: {meta.get('dtype')!r}")
    dtype = dtypes[meta["dtype"]]
    size = os.path.getsize(prefix + ".bin")
    if size == 0 or size % dtype.itemsize:
        raise ValueError("token stream is empty or contains an incomplete token")
    vocab, eos = meta.get("vocab_size"), meta.get("eos_id")
    if type(vocab) is not int or vocab <= 0 or type(eos) is not int or not 0 <= eos < vocab:
        raise ValueError("invalid vocab_size/eos_id in token metadata")
    data = np.memmap(prefix + ".bin", dtype=dtype, mode="r")
    for start in range(0, len(data), 1_000_000):
        if int(data[start:start + 1_000_000].max()) >= vocab:
            raise ValueError("token stream contains token ids outside the vocabulary")
    return data, meta


def batch_windows(data, ctx: int, bsz: int, rng: np.random.Generator, device: str):
    if ctx < 1 or bsz < 1:
        raise ValueError("ctx and batch size must be positive")
    if len(data) < ctx + 1:
        raise ValueError(f"token stream requires at least {ctx + 1} tokens; got {len(data)}")
    # numpy's upper bound is exclusive. The last valid start is len(data)-ctx-1.
    starts = rng.integers(0, len(data) - ctx, size=bsz)
    x = np.stack([data[s:s + ctx] for s in starts]).astype(np.int64)
    y = np.stack([data[s + 1:s + ctx + 1] for s in starts]).astype(np.int64)
    return (torch.from_numpy(x).to(device, non_blocking=True),
            torch.from_numpy(y).to(device, non_blocking=True))


def lr_at(step: int, warmup: int, total: int, peak: float, floor: float) -> float:
    if step < warmup:
        return peak * (step + 1) / max(1, warmup)
    p = min(1.0, (step - warmup) / max(1, total - warmup))
    return floor + 0.5 * (peak - floor) * (1 + math.cos(math.pi * p))


def param_groups(model, wd: float):
    decay, no_decay = [], []
    for name, p in model.named_parameters():
        (decay if p.ndim == 2 else no_decay).append(p)   # matrices decay, vectors don't
    return [{"params": decay, "weight_decay": wd}, {"params": no_decay, "weight_decay": 0.0}]


def split_stream(data, ctx: int):
    """Preserve the existing holdout policy, rejecting unusable splits early."""
    if ctx < 1:
        raise ValueError("ctx must be positive")
    n_val = max(ctx * 50, len(data) // 100)
    n_train = len(data) - n_val
    if n_train < ctx + 1 or n_val < ctx + 1:
        raise ValueError(
            f"token stream too short for train/validation split: {len(data)} tokens, "
            f"ctx={ctx}, requested holdout={n_val}; each split needs ctx+1 tokens")
    return data[:n_train], data[n_train:]


def validate_training_args(args: argparse.Namespace) -> None:
    """Reject malformed jobs before allocating model parameters or GPU memory."""
    for name in ("ctx", "max_seq_len", "embed_dim", "heads", "layers", "ffn_dim",
                 "batch", "accum", "steps", "eval_every", "eval_iters"):
        if getattr(args, name) < 1:
            raise ValueError(f"--{name.replace('_', '-')} must be positive")
    if args.ctx > args.max_seq_len:
        raise ValueError("--ctx must not exceed --max-seq-len")
    arch, preset = getattr(args, "arch", "ilaria"), getattr(args, "preset", "")
    if arch == "imc":
        kv_heads = getattr(args, "kv_heads", 4)
        if preset and preset not in PRESETS:
            raise ValueError(f"--preset must be one of {sorted(PRESETS)}")
        if not preset and (kv_heads < 1 or args.heads % kv_heads):
            raise ValueError("--heads must be divisible by --kv-heads")
    elif preset:
        raise ValueError("--preset applies only to --arch imc")
    if args.embed_dim % args.heads:
        raise ValueError("--embed-dim must be divisible by --heads")
    if args.rope and (args.embed_dim // args.heads) % 2:
        raise ValueError("RoPE requires an even head dimension")
    if not 0 <= args.dropout < 1:
        raise ValueError("--dropout must be in [0, 1)")
    if args.warmup < 0 or args.seed < 0:
        raise ValueError("--warmup and --seed must be non-negative")
    if (not math.isfinite(args.lr) or not math.isfinite(args.min_lr)
            or not 0 <= args.min_lr <= args.lr or args.lr == 0):
        raise ValueError("learning rates must be finite and satisfy 0 <= min-lr <= lr, lr > 0")
    if not math.isfinite(args.wd) or args.wd < 0:
        raise ValueError("--wd must be finite and non-negative")


@torch.no_grad()
def evaluate(model, data, ctx, bsz, device, iters, rng, autocast_dtype):
    if iters < 1:
        raise ValueError("evaluation iterations must be positive")
    was_training = model.training
    model.eval()
    losses = []
    use_amp = device == "cuda" and autocast_dtype is not None
    try:
        for _ in range(iters):
            x, y = batch_windows(data, ctx, bsz, rng, device)
            with torch.autocast("cuda", dtype=autocast_dtype or torch.float16, enabled=use_amp):
                logits = model(x)
            losses.append(F.cross_entropy(logits.float().view(-1, logits.size(-1)), y.view(-1)).item())
        return float(np.mean(losses))
    finally:
        model.train(was_training)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="token stream prefix (from cmd/corpus-tokenize)")
    ap.add_argument("--out", required=True, help="output dir (transformer.nxtf + tokenizer.json copied here)")
    ap.add_argument("--tokenizer", default="", help="tokenizer.json to copy next to the brain (default: from stream meta)")
    ap.add_argument("--arch", choices=["ilaria", "imc"], default="ilaria",
                    help="ilaria = Go MiniTransformer twin (NXTF export); imc = Ilaria MicroCortex (GQA, RMSNorm, imc.pt export)")
    ap.add_argument("--preset", default="", help=f"imc size preset: {', '.join(PRESETS)} (overrides the dimension flags)")
    ap.add_argument("--kv-heads", type=int, default=4, help="imc: key/value heads for grouped-query attention")
    ap.add_argument("--ffn-act", choices=["silu", "relu2"], default="silu", help="imc: gated FFN activation")
    ap.add_argument("--embed-dim", type=int, default=384)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--layers", type=int, default=6)
    ap.add_argument("--ffn-dim", type=int, default=1536)
    ap.add_argument("--ctx", type=int, default=512)
    ap.add_argument("--max-seq-len", type=int, default=1024)
    ap.add_argument("--rope", action="store_true")
    ap.add_argument("--swiglu", action="store_true")
    ap.add_argument("--ternary", action="store_true",
                    help="BitNet b1.58 training: ternary block weights and 8-bit activations (straight-through)")
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
    ap.add_argument("--resume", default="", help="versioned checkpoint .pt to resume exactly from")
    ap.add_argument("--init-from", default="", help="warm start from matching legacy/current PT weights; resets optimizer and RNG")
    ap.add_argument("--stop-after", type=int, default=0,
                    help="stop after N steps in this invocation without changing the total LR horizon")
    ap.add_argument("--precision", default="auto", choices=["auto", "bf16", "fp16", "fp32"],
                    help="compute precision: auto (bf16 on H100/Ampere, else fp16), bf16, fp16, fp32")
    ap.add_argument("--compile", action="store_true", help="use torch.compile for maximum H100 kernel fusion")
    ap.add_argument("--grad-checkpoint", action="store_true", help="enable gradient checkpointing to save VRAM")
    ap.add_argument("--chunked-loss", action="store_true",
                    help="imc: cross-entropy in chunks with recomputed logits, never materializing [tokens, vocab]")
    args = ap.parse_args()
    try:
        validate_training_args(args)
        if args.resume and args.init_from:
            raise ValueError("--resume and --init-from are mutually exclusive")
        if args.stop_after < 0:
            raise ValueError("--stop-after must be non-negative")
        if args.chunked_loss and args.arch != "imc":
            raise ValueError("--chunked-loss applies only to --arch imc")
    except ValueError as exc:
        ap.error(str(exc))

    # torchrun sets these; a plain launch is a world of one. Every rank reads a
    # different random slice of the stream; rank 0 alone evaluates, logs and saves.
    world = int(os.environ.get("WORLD_SIZE", "1"))
    rank = int(os.environ.get("RANK", "0"))
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    master = rank == 0
    if not master:
        sys.stdout = open(os.devnull, "w")

    device = "cuda" if torch.cuda.is_available() and torch.cuda.device_count() > 0 else "cpu"
    if device == "cuda":
        if local_rank >= torch.cuda.device_count():
            ap.error(f"LOCAL_RANK {local_rank} but only {torch.cuda.device_count()} CUDA device(s) are visible")
        torch.cuda.set_device(local_rank)
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    if world > 1:
        import torch.distributed as dist
        dist.init_process_group("nccl" if device == "cuda" and os.name != "nt" else "gloo")

    # Precision resolution
    if args.precision == "auto":
        use_bf16 = device == "cuda" and torch.cuda.is_bf16_supported()
        autocast_dtype = torch.bfloat16 if use_bf16 else (torch.float16 if device == "cuda" else None)
    elif args.precision == "bf16":
        autocast_dtype = torch.bfloat16
    elif args.precision == "fp16":
        autocast_dtype = torch.float16
    else:
        autocast_dtype = None

    if device == "cpu" and args.precision not in ("auto", "fp32"):
        ap.error("explicit fp16/bf16 requires CUDA; use --precision fp32 on CPU")
    if device == "cuda" and autocast_dtype == torch.bfloat16 and not torch.cuda.is_bf16_supported():
        ap.error("requested bf16 is unsupported by this CUDA device")
    use_scaler = (device == "cuda" and autocast_dtype == torch.float16)

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed if world == 1 else [args.seed, rank])

    data, meta = load_stream(args.data)
    try:
        train_data, val_data = split_stream(data, args.ctx)
    except ValueError as exc:
        ap.error(str(exc))
    print(f"[forge] tokens: {len(data):,} (train {len(train_data):,} / val {len(val_data):,}) "
          f"vocab {meta['vocab_size']} eos {meta['eos_id']} device {device} (precision: {autocast_dtype})")

    if args.arch == "imc":
        dims = PRESETS[args.preset] if args.preset else dict(
            d_model=args.embed_dim, n_layers=args.layers, n_heads=args.heads,
            n_kv_heads=args.kv_heads, ffn_dim=args.ffn_dim)
        cfg = ImcConfig(vocab_size=meta["vocab_size"], max_seq_len=args.max_seq_len,
                        eos_token_id=meta["eos_id"], ffn_act=args.ffn_act, ternary=args.ternary, **dims)
        model = ImcTransformer(cfg)
        best_name, export = "imc.pt", save_imc
        desc = (f"imc d={cfg.d_model} layers={cfg.n_layers} heads={cfg.n_heads}/{cfg.n_kv_heads}kv "
                f"ffn={cfg.ffn_dim} act={cfg.ffn_act}")
    else:
        cfg = IlariaConfig(vocab_size=meta["vocab_size"], embed_dim=args.embed_dim,
                           num_heads=args.heads, num_layers=args.layers, ffn_dim=args.ffn_dim,
                           max_seq_len=args.max_seq_len, eos_token_id=meta["eos_id"],
                           dropout_rate=args.dropout, use_rope=args.rope, use_swiglu=args.swiglu,
                           ternary=args.ternary)
        model = IlariaTransformer(cfg)
        best_name, export = "transformer.nxtf", save_nxtf
        desc = f"rope={cfg.use_rope} swiglu={cfg.use_swiglu}"
    if args.grad_checkpoint:
        model.enable_gradient_checkpointing(True)
    model = model.to(device)

    print(f"[forge] model: {model.param_count()/1e6:.1f}M params | {desc} ternary={cfg.ternary} "
          f"ctx={args.ctx} batch={args.batch}x{args.accum} (effective batch {args.batch * args.accum}) "
          f"grad_checkpoint={args.grad_checkpoint} compile={args.compile}")

    opt = torch.optim.AdamW(param_groups(model, args.wd), lr=args.lr, betas=(0.9, 0.95), eps=1e-8)
    scaler = torch.amp.GradScaler("cuda", enabled=use_scaler)
    start_step, best_val, tokens_seen = 0, float("inf"), 0
    tok_src = args.tokenizer or meta.get("tokenizer", "")
    if tok_src and not os.path.isfile(tok_src):
        ap.error(f"tokenizer file does not exist: {tok_src}")
    signature = training_signature(args, device, autocast_dtype,
                                   file_sha256(args.data + ".bin"),
                                   file_sha256(tok_src) if tok_src else None)
    signature["stream_format"] = {k: meta[k] for k in ("dtype", "vocab_size", "eos_id")}
    if world > 1:
        signature["world_size"] = world   # absent for one process: single-GPU checkpoints still resume
    best_nxtf_sha256 = None
    ck = None
    if args.init_from:
        initialize_weights(torch.load(args.init_from, map_location="cpu", weights_only=True), model)
    if args.resume:
        # Never silently opt out of the restricted unpickler.
        ck = torch.load(args.resume, map_location="cpu", weights_only=True)

    # Save reference to raw model for checkpointing/saving before compilation
    raw_model = model
    if world > 1:
        from torch.nn.parallel import DistributedDataParallel
        model = DistributedDataParallel(model, device_ids=[local_rank] if device == "cuda" else None)
    if args.compile:
        print("[forge] compiling model with torch.compile...")
        model = torch.compile(model)

    if ck is not None:
        start_step, best_val, tokens_seen = restore_checkpoint(
            ck, raw_model, opt, scaler, rng, signature)
        best_nxtf_sha256 = ck.get("best_nxtf_sha256")
        if math.isfinite(best_val):
            best_source = os.path.join(os.path.dirname(os.path.abspath(args.resume)), best_name)
            if not best_nxtf_sha256 or not os.path.isfile(best_source) or file_sha256(best_source) != best_nxtf_sha256:
                ap.error("best NXTF export is missing or differs from the checkpoint; restore the matching run directory")
        print(f"[forge] resumed from {args.resume} @ step {start_step}")
        del ck
        if world > 1:
            # The checkpoint holds rank 0's sampler state; give every rank its own again.
            rng = np.random.default_rng([args.seed, rank, start_step])

    os.makedirs(args.out, exist_ok=True)
    if master and args.resume and math.isfinite(best_val):
        best_destination = os.path.join(args.out, best_name)
        if os.path.realpath(best_source) != os.path.realpath(best_destination):
            import shutil
            with open(best_source, "rb") as src, atomic_binary_writer(best_destination) as dst:
                shutil.copyfileobj(src, dst)
    if master and tok_src and os.path.exists(tok_src):
        import shutil
        tok_dst = os.path.join(args.out, "tokenizer.json")
        if os.path.abspath(tok_src) != os.path.abspath(tok_dst):
            with atomic_binary_writer(tok_dst) as dst, open(tok_src, "rb") as src:
                shutil.copyfileobj(src, dst)

    log = open(os.path.join(args.out, "training.log"), "a") if master else None
    model.train()
    t0 = time.time()
    tokens_this_run = 0
    use_amp = device == "cuda" and autocast_dtype is not None

    stop_step = min(args.steps, start_step + args.stop_after) if args.stop_after else args.steps
    for step in range(start_step, stop_step):
        lr = lr_at(step, args.warmup, args.steps, args.lr, args.min_lr)
        for g in opt.param_groups:
            g["lr"] = lr
        opt.zero_grad(set_to_none=True)
        loss_acc = 0.0
        for micro in range(args.accum):
            x, y = batch_windows(train_data, args.ctx, args.batch, rng, device)
            # Gradients are all-reduced once per optimizer step, on the last micro-batch.
            sync = world == 1 or micro == args.accum - 1
            with (contextlib.nullcontext() if sync else model.no_sync()):
                with torch.autocast("cuda", dtype=autocast_dtype or torch.float16, enabled=use_amp):
                    if args.chunked_loss:
                        loss = model(x, y) / args.accum
                    else:
                        logits = model(x)
                        loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1)) / args.accum
                if use_scaler:
                    scaler.scale(loss).backward()
                else:
                    loss.backward()
            loss_acc += loss.item()
            tokens_seen += x.numel() * world
            tokens_this_run += x.numel() * world

        if use_scaler:
            scaler.unscale_(opt)
            gn = torch.nn.utils.clip_grad_norm_(raw_model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
        else:
            gn = torch.nn.utils.clip_grad_norm_(raw_model.parameters(), 1.0, error_if_nonfinite=True)
            opt.step()

        if step % 20 == 0:
            el = time.time() - t0
            print(f"step {step:6d} | loss {loss_acc:.4f} | lr {lr:.2e} | gn {gn:.2f} | "
                  f"{tokens_this_run/max(el,1e-9):,.0f} tok/s | {el/60:.1f} min")
        do_eval = (step + 1) % args.eval_every == 0 or step + 1 == args.steps
        if master and do_eval:
            # Fixed validation windows, independent of the training RNG and eval cadence.
            eval_rng = np.random.default_rng(np.random.SeedSequence([args.seed, 1]))
            # Under DDP the wrapper's forward is collective, so rank 0 evaluates the bare model.
            val = evaluate(model if world == 1 else raw_model, val_data, args.ctx, args.batch, device,
                           args.eval_iters, eval_rng, autocast_dtype)
            if not math.isfinite(val):
                raise RuntimeError("non-finite validation loss; previous checkpoint was preserved")
            improved = val < best_val
            best_val = min(best_val, val)
            print(f"[eval] step {step+1} val_loss {val:.4f} ppl {math.exp(val):.1f} "
                  f"{'(new best, exported)' if improved else ''}")
            log.write(json.dumps({"step": step + 1, "train_loss": loss_acc, "val_loss": val,
                                  "ppl": math.exp(val), "lr": lr, "tokens": tokens_seen}) + "\n")
            log.flush()
            if improved:
                best_path = os.path.join(args.out, best_name)
                export(raw_model, best_path)
                best_nxtf_sha256 = file_sha256(best_path)
        # A pause between evaluations saves resume state WITHOUT adding an eval
        # or changing which models qualify as best. Both files are individually
        # atomic; the hash detects mismatched publication after interruption.
        if master and (do_eval or step + 1 == stop_step):
            with atomic_binary_writer(os.path.join(args.out, "checkpoint.pt")) as checkpoint:
                torch.save(make_checkpoint(raw_model, opt, scaler, rng, step + 1,
                                           best_val, tokens_seen, signature, best_nxtf_sha256), checkpoint)
        if world > 1 and (do_eval or step + 1 == stop_step):
            dist.barrier()   # nobody runs ahead while rank 0 evaluates and saves

    if master:
        log.close()

    if world > 1:
        dist.destroy_process_group()
    if not master:
        return
    # Sanity sample straight from the forge (greedy, token ids only — the
    # organism decodes; Go owns the tokenizer).
    ids = raw_model.generate_greedy([meta["eos_id"]], 30)
    print(f"[forge] greedy sample ids: {ids}")
    status = "DONE" if stop_step == args.steps else "PAUSED"
    if math.isfinite(best_val):
        print(f"[forge] {status} — best val {best_val:.4f} (ppl {math.exp(best_val):.1f}) -> {args.out}/{best_name}")
    else:
        print(f"[forge] {status} — resume checkpoint saved; no scheduled validation/best export yet")


if __name__ == "__main__":
    main()
